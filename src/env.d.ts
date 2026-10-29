export {};

declare global {
  interface Env {
    CSRF_SECRET: string;
    TOKEN_ENC_KEY: string;
    X_CLIENT_ID: string;
    X_CLIENT_SECRET: string;
    INTAKE_TOKEN: string;
  }
}
