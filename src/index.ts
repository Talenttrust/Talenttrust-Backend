import { createApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const app = createApp({ config });

app.listen(config.port, () => {
  console.log(`TalentTrust API listening on http://localhost:${config.port}`);
});
