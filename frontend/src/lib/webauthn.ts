// All native ceremonies share the lifecycle guard used by browser resume recovery.
export { startAuthentication, startRegistration } from "@ludiars/cernere-composite/ui";
export type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
