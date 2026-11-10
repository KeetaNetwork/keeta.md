declare const server: string;
declare const signUp: string;
declare const message: string;
declare const connection: { orgId: string; orgName: string; mcpUrl: string; tokenUrl: string; clientId: string; accessToken: string; refreshToken: string; expiresIn: number };
declare function tool(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
declare const billing: { credits: { balance: string; available: string; owed: string }; spendingStopped: null | string; seats: null | { plan: string; state: string; seats: number; periodEnd: string }; deposit: null | { chain: 'keeta'; network: string; address: string; tokens: Array<{ symbol: string; address: string; decimals: number }> } };
