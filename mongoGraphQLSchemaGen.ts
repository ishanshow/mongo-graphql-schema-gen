import { MongoClient, Db, Collection } from 'mongodb';
import fs from 'fs';

// Schema Generation Function
async function schemaGen() {
  const connectionString = 'YOUR_CONNECTION_STRING';
  const databaseName = 'YOUR_DATABASE_NAME';
  const collectionNames = ['YOUR_COLLECTION_NAME'];
  
  try {
    const graphqlSchema = await convertMongoSchemaToGraphQL(
      connectionString,
      databaseName,
      collectionNames
    );

    const outputPath = './generated-schema.graphql';
    fs.writeFileSync(outputPath, graphqlSchema, 'utf8');
    
    console.log('Generated GraphQL Schema:');
    console.log(`Schema saved to: ${outputPath}`);
    console.log('\nSchema preview:');
    console.log(graphqlSchema);
  } catch (error) {
    console.error('Error generating schema:', error);
  }
}

// MongoDB to GraphQL Schema Converter (using native MongoDB driver)
export class MongoToGraphQLConverter {
  private db: Db;
  private nestedTypes: Map<string, {[key: string]: {type: string, required: boolean}}> = new Map();

  constructor(db: Db) {
    this.db = db;
  }

  private inferTypeFromValue(value: any, fieldName: string, parentTypeName: string): string {
    if (value === null || value === undefined) return 'String';
    
    switch (typeof value) {
      case 'string':
        // Check if it's an ObjectId string
        if (/^[0-9a-fA-F]{24}$/.test(value)) {
          return 'ID';
        }
        return 'String';
      case 'number':
        return Number.isInteger(value) ? 'Int' : 'Float';
      case 'boolean':
        return 'Boolean';
      case 'object':
        if (value instanceof Date) return 'String';
        if (Array.isArray(value)) {
          if (value.length === 0) return '[String]';
          const firstElement = value[0];
          if (typeof firstElement === 'object' && firstElement !== null && !Array.isArray(firstElement)) {
            // Array of objects - create a nested type
            const nestedTypeName = `${parentTypeName}${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)}`;
            this.analyzeNestedObject(firstElement, nestedTypeName);
            return `[${nestedTypeName}!]`;
          }
          const elementType = this.inferTypeFromValue(firstElement, fieldName, parentTypeName);
          return `[${elementType}]`;
        }
        // Nested object - create a nested type
        const nestedTypeName = `${parentTypeName}${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)}`;
        this.analyzeNestedObject(value, nestedTypeName);
        return nestedTypeName;
      default:
        return 'String';
    }
  }

  private analyzeNestedObject(obj: any, typeName: string): void {
    if (this.nestedTypes.has(typeName)) return; // Already analyzed

    const schema: {[key: string]: {type: string, required: boolean}} = {};
    
    for (const [field, value] of Object.entries(obj)) {
      if (field === '__v' || field === '_id') continue;
      
      const inferredType = this.inferTypeFromValue(value, field, typeName);
      schema[field] = {
        type: inferredType + '!', // Assume required for simplicity in nested objects
        required: true
      };
    }
    
    this.nestedTypes.set(typeName, schema);
  }

  private async analyzeCollection(collectionName: string, sampleSize: number = 100): Promise<{[key: string]: {type: string, required: boolean}}> {
    const collection = this.db.collection(collectionName);
    
    // Get a sample of documents
    const documents = await collection.aggregate([
      { $sample: { size: sampleSize } }
    ]).toArray();

    if (documents.length === 0) {
      return {};
    }

    // Get the type name for this collection
    const typeName = collectionName.charAt(0).toUpperCase() + 
                    collectionName.slice(1).replace(/s$/, '');

    // Analyze all fields across documents
    const fieldAnalysis: {[key: string]: {types: Set<string>, count: number}} = {};
    
    for (const doc of documents) {
      for (const [field, value] of Object.entries(doc)) {
        if (field === '__v') continue; // Skip version key
        
        if (!fieldAnalysis[field]) {
          fieldAnalysis[field] = { types: new Set(), count: 0 };
        }
        
        fieldAnalysis[field].count++;
        const inferredType = this.inferTypeFromValue(value, field, typeName);
        fieldAnalysis[field].types.add(inferredType);
      }
    }

    // Convert analysis to GraphQL types
    const schema: {[key: string]: {type: string, required: boolean}} = {};
    
    for (const [field, analysis] of Object.entries(fieldAnalysis)) {
      if (field === '_id') {
        schema['id'] = { type: 'ID!', required: true };
        continue;
      }
      
      // Determine if field is required (appears in >80% of documents)
      const requiredThreshold = documents.length * 1;
      const isRequired = analysis.count >= requiredThreshold;
      
      // Pick the most common type or use union if multiple types
      let graphqlType: string;
      if (analysis.types.size === 1) {
        graphqlType = Array.from(analysis.types)[0];
      } else {
        // If multiple types, default to String for simplicity
        graphqlType = 'String';
      }
      
      // Don't add ! if the type already includes it (for nested types)
      const hasExclamation = graphqlType.includes('!') || graphqlType.includes('[');
      schema[field] = {
        type: hasExclamation ? graphqlType : graphqlType + (isRequired ? '!' : ''),
        required: isRequired
      };
    }

    return schema;
  }

  public async generateTypeDefinition(collectionName: string): Promise<string> {
    const schema = await this.analyzeCollection(collectionName);
    
    // Convert collection name to PascalCase for GraphQL type name
    const typeName = collectionName.charAt(0).toUpperCase() + 
                    collectionName.slice(1).replace(/s$/, ''); // Remove trailing 's'
    
    const fields = Object.entries(schema)
      .map(([field, {type}]) => `  ${field}: ${type}`)
      .join('\n');
    
    return `type ${typeName} {\n${fields}\n}`;
  }

  public async generateFullSchema(collectionNames: string[]): Promise<string> {
    const types: string[] = [];
    
    // Generate types for each collection
    for (const collectionName of collectionNames) {
      const typeDef = await this.generateTypeDefinition(collectionName);
      types.push(typeDef);
    }
    
    // Generate nested types
    for (const [typeName, schema] of this.nestedTypes.entries()) {
      const fields = Object.entries(schema)
        .map(([field, {type}]) => `  ${field}: ${type}`)
        .join('\n');
      types.push(`type ${typeName} {\n${fields}\n}`);
    }
    
    // Generate Query type
    const queries = collectionNames.map(collectionName => {
      const typeName = collectionName.charAt(0).toUpperCase() + 
                      collectionName.slice(1).replace(/s$/, '');
      
      // Convert PascalCase to snake_case
      const singularName = typeName
        .replace(/([A-Z])/g, (match, letter, index) => index === 0 ? letter.toLowerCase() : '_' + letter.toLowerCase())
        .toLowerCase();
      
      // Create proper plural form
      let pluralName: string;
      if (singularName.endsWith('x') || singularName.endsWith('s') || 
          singularName.endsWith('sh') || singularName.endsWith('ch')) {
        pluralName = singularName + 'es';
      } else if (singularName.endsWith('y') && !['a', 'e', 'i', 'o', 'u'].includes(singularName.charAt(singularName.length - 2))) {
        // If ends with 'y' preceded by consonant, change 'y' to 'ies'
        pluralName = singularName.slice(0, -1) + 'ies';
      } else {
        pluralName = singularName + 's';
      }
      
      return [
        `  ${pluralName}: [${typeName}!]!`,
        `  ${singularName}(id: ID!): ${typeName}`
      ];
    }).flat();
    
    const queryType = `type Query {\n${queries.join('\n')}\n}`;
    
    return [...types, queryType].join('\n\n');
  }
}

// Usage function
export async function convertMongoSchemaToGraphQL(
  connectionString: string,
  databaseName: string,
  collectionNames?: string[]
): Promise<string> {
  const client = new MongoClient(connectionString);
  
  try {
    await client.connect();
    const db = client.db(databaseName);
    
    // If no collection names provided, get all collections
    if (!collectionNames) {
      const collections = await db.listCollections().toArray();
      collectionNames = collections.map(col => col.name);
    }
    
    const converter = new MongoToGraphQLConverter(db);
    return await converter.generateFullSchema(collectionNames);
  } finally {
    await client.close();
  }
}

// Uncomment to run the schema generator
schemaGen();
