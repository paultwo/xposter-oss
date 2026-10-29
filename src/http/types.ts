import type { Context } from "hono";

export type Identity =
  | { kind: "human"; email: string }
  | { kind: "service"; tokenId: string; name: string };

export type FormMap = Record<string, string | File>;

export type AppEnv = {
  Bindings: Env;
  Variables: {
    identity: Identity;
    csrf: string;
    form: FormMap | null;
  };
};

export type AppContext = Context<AppEnv>;
