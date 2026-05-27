import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { registry } from './openapi-registry';
import * as yaml from 'yaml';
import * as fs from 'fs';
import * as path from 'path';

// Import all routes/schemas so they register themselves
import '../modules/contracts/dto/contract.dto';
import '../modules/contractMetadata/contractMetadata.schema';
import '../modules/reputation/dto/reputation.dto';
import '../routes/contracts.routes';
import '../routes/reputation.routes';
import '../routes/health';

export function generateOpenApiSpec() {
  const generator = new OpenApiGeneratorV3(registry.definitions);

  const spec = generator.generateDocument({
    openapi: '3.0.0',
    info: {
      version: '1.0.0',
      title: 'TalentTrust API',
      description: 'TalentTrust API Gateway and services documentation',
    },
    servers: [{ url: '/api/v1' }],
  });

  return spec;
}

if (require.main === module) {
  const spec = generateOpenApiSpec();
  const yamlSpec = yaml.stringify(spec);
  const outputPath = path.join(__dirname, '../../docs/openapi.yaml');
  
  if (!fs.existsSync(path.dirname(outputPath))) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  }
  
  fs.writeFileSync(outputPath, yamlSpec);
  console.log(`OpenAPI spec generated at ${outputPath}`);
}
