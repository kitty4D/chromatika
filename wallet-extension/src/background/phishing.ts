import checkDomain from 'eth-phishing-detect';

export function isPhishingDomain(host: string): boolean {
  const h = host.replace(/^www\./, '');
  return checkDomain(h);
}
