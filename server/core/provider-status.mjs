export function providerConfigured(provider) {
  return Boolean(provider?.apiKey) || provider?.local === true;
}
