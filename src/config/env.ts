import { z } from "zod";

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);
const booleanString = z.enum(["true", "false"]).default("false").transform((value) => value === "true");
const notebookIdPattern = /^\d{14}-[a-z0-9]{7}$/u;
const notebookIdList = z
  .string()
  .default("")
  .superRefine((value, context) => {
    for (const id of splitNotebookIds(value)) {
      if (!notebookIdPattern.test(id)) {
        context.addIssue({ code: "custom", message: `Invalid SiYuan notebook ID: ${id}` });
      }
    }
  });

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    AUTH_MODE: z.enum(["none", "fixed", "oauth"]).default("fixed"),
    ANONYMOUS_WRITE_ENABLED: booleanString,
    MCP_FIXED_TOKEN: z.string().min(16).optional(),
    MCP_PUBLIC_URL: optionalUrl,
    OAUTH_ISSUER_URL: optionalUrl,
    OAUTH_AUDIENCE: z.string().min(1).optional(),
    OAUTH_JWKS_URL: optionalUrl,
    OAUTH_SCOPES: z.string().default("siyuan.read siyuan.write"),
    SIYUAN_BASE_URL: z.string().url(),
    SIYUAN_TOKEN: z.string().min(1),
    SIYUAN_NOTEBOOK_ALLOWLIST: notebookIdList,
    SIYUAN_NOTEBOOK_DENYLIST: notebookIdList,
    SIYUAN_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(20_000),
    SIYUAN_READ_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  })
  .superRefine((env, context) => {
    if (env.AUTH_MODE === "fixed" && !env.MCP_FIXED_TOKEN) {
      context.addIssue({ code: "custom", path: ["MCP_FIXED_TOKEN"], message: "required in fixed mode" });
    }
    if (
      env.AUTH_MODE === "none" &&
      env.ANONYMOUS_WRITE_ENABLED &&
      splitNotebookIds(env.SIYUAN_NOTEBOOK_ALLOWLIST).length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["SIYUAN_NOTEBOOK_ALLOWLIST"],
        message: "a non-empty allowlist is required when anonymous writes are enabled",
      });
    }
    if (env.AUTH_MODE === "oauth") {
      for (const key of ["MCP_PUBLIC_URL", "OAUTH_ISSUER_URL", "OAUTH_AUDIENCE"] as const) {
        if (!env[key]) {
          context.addIssue({ code: "custom", path: [key], message: "required in oauth mode" });
        }
      }
    }
  });

export type Config = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  auth:
    | { mode: "none"; writeEnabled: boolean }
    | { mode: "fixed"; token: string }
    | {
        mode: "oauth";
        publicUrl: string;
        issuerUrl: string;
        audience: string;
        jwksUrl?: string;
        scopes: string[];
      };
  siyuan: {
    baseUrl: string;
    token: string;
    timeoutMs: number;
    readRetries: number;
  };
  notebookAccess: {
    allowlist: string[];
    denylist: string[];
  };
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const env = envSchema.parse(source);
  const auth: Config["auth"] =
    env.AUTH_MODE === "none"
      ? { mode: "none", writeEnabled: env.ANONYMOUS_WRITE_ENABLED }
      : env.AUTH_MODE === "fixed"
      ? { mode: "fixed", token: env.MCP_FIXED_TOKEN! }
      : {
          mode: "oauth",
          publicUrl: stripTrailingSlash(env.MCP_PUBLIC_URL!),
          issuerUrl: env.OAUTH_ISSUER_URL!,
          audience: env.OAUTH_AUDIENCE!,
          ...(env.OAUTH_JWKS_URL ? { jwksUrl: env.OAUTH_JWKS_URL } : {}),
          scopes: env.OAUTH_SCOPES.split(/\s+/u).filter(Boolean),
        };

  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    auth,
    siyuan: {
      baseUrl: stripTrailingSlash(env.SIYUAN_BASE_URL),
      token: env.SIYUAN_TOKEN,
      timeoutMs: env.SIYUAN_TIMEOUT_MS,
      readRetries: env.SIYUAN_READ_RETRIES,
    },
    notebookAccess: {
      allowlist: unique(splitNotebookIds(env.SIYUAN_NOTEBOOK_ALLOWLIST)),
      denylist: unique(splitNotebookIds(env.SIYUAN_NOTEBOOK_DENYLIST)),
    },
  };
}

function splitNotebookIds(value: string): string[] {
  return value.split(/[\s,]+/u).filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}
