// C-13: a registered kiosk is active, keyed by lanId, and published with an https LAN URL.
type Kiosk = { readonly lanId: string; readonly status: string; readonly lanUrl: string; readonly publicKeyPem: string };

export default {
  post: (result: Kiosk, input: { readonly lanId: string }): true | string => {
    if (result.lanId !== input.lanId) return 'lanId must be the registry key';
    if (result.status !== 'active') return 'a registration must leave the kiosk active';
    if (!result.lanUrl.startsWith('https://')) return 'lanUrl must be https';
    return result.publicKeyPem.includes('BEGIN PUBLIC KEY') || 'publicKeyPem must be an SPKI PEM';
  },
};
