/// <reference types="@cloudflare/vitest-pool-workers" />

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    MIGRATIONS_JSON: string;
    BUFFER_JSON: string;
  }
}
