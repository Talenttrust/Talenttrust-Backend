import express, { Request, Response } from 'express';
import { DefaultServiceObjectives, DefaultAlertThresholds } from './operations/service-objectives';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'talenttrust-backend' });
});

app.get('/api/v1/contracts', (_req: Request, res: Response) => {
  res.json({ contracts: [] });
});

app.listen(PORT, () => {
  console.log(`TalentTrust API listening on http://localhost:${PORT}`);
  console.log('Active Service Objectives initialized:');
  Object.keys(DefaultServiceObjectives).forEach((key) => {
    console.log(` - ${key}: Target ${DefaultServiceObjectives[key].targetSuccessRatePercent}% success, p95: ${DefaultServiceObjectives[key].targetLatencyP95Ms}ms`);
  });
});
