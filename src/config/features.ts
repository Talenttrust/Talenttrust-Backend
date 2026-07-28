import { parseBoolEnv } from './env';

export interface FeaturesConfig {
  disputesEnabled: boolean;
  webhooksEnabled: boolean;
}

export const features: FeaturesConfig = {
  disputesEnabled: parseBoolEnv('DISPUTES_FEATURE_ENABLED', true),
  webhooksEnabled: parseBoolEnv('WEBHOOKS_ENABLED', true),
};
