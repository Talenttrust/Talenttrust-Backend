import { createApp } from './app';
import { loadRuntimeConfig } from './config/runtime-config';

const runtimeConfig = loadRuntimeConfig();
const app = createApp(runtimeConfig);

app.listen(runtimeConfig.port, () => {
  console.log(`TalentTrust API listening on http://localhost:${runtimeConfig.port}`);
});
