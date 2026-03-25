import express, { Request, Response } from 'express';
import { contractMetadataRoutes } from './modules/contractMetadata/contractMetadata.routes';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'talenttrust-backend' });
});

app.get('/api/v1/contracts', (_req: Request, res: Response) => {
  res.json({ contracts: [] });
});

// Register contract metadata routes
app.use('/api/v1', contractMetadataRoutes);

app.listen(PORT, () => {
  console.log(`TalentTrust API listening on http://localhost:${PORT}`);
});
