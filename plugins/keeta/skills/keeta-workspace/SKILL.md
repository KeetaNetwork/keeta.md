---
name: keeta-workspace
description: "Give your person a Keeta Workspace account with your own Keeta account: sign them up with the code emailed to them, fund their organization with KUSD or USDC on Keeta (or tokens from other chains), start projects and hand tasks to Workspace's agents. Signs in again later with the same Keeta account. Use when the user wants work planned and done in Keeta Workspace, or asks you to set up, fund or use Workspace for them."
license: Apache-2.0
---

# Keeta Workspace for agents

## When to use

Use when the user wants work done in Keeta Workspace, where projects hold tasks that Workspace's agents plan, build and check, paid for with credits (1 credit is 1 US dollar).

- You need your own Keeta account to sign up and sign in. Make one with [create-fund-wallet](../create-fund-wallet/SKILL.md) if you have none, and keep its seed as you keep any secret. Fund it only with what the person agreed to spend on Workspace, or give it limits with [spend-policy](../spend-policy/SKILL.md): it is the account that pays.
- The person must give you the six-digit code Workspace emails them. You never make an account without it.
- If the person already has a Workspace account, don't sign up: ask them to connect you from Settings › Connected apps, which gives you the same tools.
- To move tokens for other purposes, use [send-receive-tokens](../send-receive-tokens/SKILL.md).

The examples use `https://app.keeta.ai`, Workspace's address; use the address the person gives you if it differs. `get_billing` names the Keeta network its deposit address is on: for `app.keeta.ai` that is `main`, so funding moves real value.

## SDK steps

Run the [keeta quickstart](../keeta/SKILL.md#quickstart-test-network) first for `client` and `account` (your agent's own account). Signing up and signing in only sign messages, so any network's client works for them. Funding needs a client on the network `get_billing` names (`KEETA_NETWORK=main` for `app.keeta.ai`): step 4 checks it. Every request below is JSON over HTTPS.

1. **Ask for the person's code.** Send their email and your Keeta address:

   ```ts
   const server = 'https://app.keeta.ai';
   const email = 'dana@example.com';
   const asked = await fetch(`${server}/api/auth/agent/sign-up`, {
     method: 'POST',
     headers: { 'content-type': 'application/json' },
     body: JSON.stringify({ email, keetaAccount: account.publicKeyString.get() }),
   });
   if (asked.status !== 202) throw new Error(`sign-up refused: ${asked.status} ${await asked.text()}`);
   const { signUp, message } = (await asked.json()) as { signUp: string; message: string; expiresAt: string };
   ```

   Every address gets the same 202, so the answer never says whether an account can be made: the email does. Tell the person a code is on its way, that it names your Keeta address, and that it works once for 15 minutes. If the email has no code, it says why: Workspace isn't open to their address yet and they are on its wait list, their company signs in another way, or their account lives in another region. Stop there; don't ask again.
2. **Finish with the code and your signature.** `message` is the text your Keeta account signs, exactly as given. Read the code from the person (or their inbox, if they let you), and never invent one:

   ```ts
   const signed = await account.sign(new TextEncoder().encode(message).buffer as ArrayBuffer);
   const signature = Buffer.from(signed.get()).toString('base64');
   const finished = await fetch(`${server}/api/auth/agent/sign-up/finish`, {
     method: 'POST',
     headers: { 'content-type': 'application/json' },
     body: JSON.stringify({
       signUp,
       code: '123456',              // the code the person gave you
       signature,
       name: 'Dana Reyes',          // the person's name
       orgName: 'Reyes Studio',     // their organization's name
       agentName: "Dana's agent",   // how Workspace lists you in Connected apps
     }),
   });
   if (finished.status !== 201) throw new Error(`sign-up refused: ${finished.status} ${await finished.text()}`);
   const connection = (await finished.json()) as {
     orgId: string; orgName: string; mcpUrl: string; tokenUrl: string;
     clientId: string; accessToken: string; refreshToken: string; expiresIn: number;
   };
   ```

   Keep `accessToken` and `refreshToken` secret. Tell the person their account is made, and that they can always sign in themselves with their email, without you.
3. **Use the tools.** `mcpUrl` is an MCP server. Connect any MCP client with `Authorization: Bearer <accessToken>`, or call a tool with one JSON-RPC request:

   ```ts
   async function tool(name: string, args: Record<string, unknown> = {}) {
     const res = await fetch(connection.mcpUrl, {
       method: 'POST',
       headers: {
         authorization: `Bearer ${connection.accessToken}`,
         'content-type': 'application/json',
         accept: 'application/json, text/event-stream',
       },
       body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
     });
     const { result } = (await res.json()) as { result: { isError?: boolean; content: Array<{ text?: string }> } };
     const text = result.content.map((c) => c.text ?? '').join('');
     if (result.isError) throw new Error(text);   // a refusal, with its reason
     return JSON.parse(text) as Record<string, unknown>;
   }
   ```

   When the access token expires (`expiresIn` seconds), get a new pair from `tokenUrl` with `grant_type=refresh_token`, your `refresh_token` and `client_id` (form-encoded, as OAuth does).
4. **Fund the organization.** `get_billing` gives the credits, whether spending has stopped and why, and the deposit address on Keeta with each token it takes:

   ```ts
   const billing = (await tool('get_billing')) as {
     credits: { balance: string; available: string; owed: string };
     spendingStopped: null | string;
     seats: null | { plan: string; state: string; seats: number; periodEnd: string };
     deposit: null | { chain: 'keeta'; network: string; address: string; tokens: Array<{ symbol: string; address: string; decimals: number }> };
   };
   ```

   - `spendingStopped` is `out_of_credits` until the first deposit; work waits until it is `null`. `org_paused` means the plan in `seats` went unpaid: credits pay it, so a deposit lets work resume once it settles.
   - `deposit` is `null` when the organization is billed another way: there is nothing to fund.
   - Anything sent to `deposit.address` becomes credits one to one, with no fee. Credits are never refunded.
   - `deposit.network` is the Keeta network to pay on (`main` or `test`). An address is the same on every network, so a send on another network never becomes credits. Stop if your client is on a different one.
   - Pick the token from `deposit.tokens`, and work out the amount in base units from its `decimals`. Confirm (see below), then send from your Keeta account:

     ```ts
     const deposit = billing.deposit!;
     const onNetwork = KeetaNet.Client.Config.getDefaultConfig(deposit.network as 'main' | 'test').network;
     if (client.network !== onNetwork) throw new Error(`fund on the Keeta ${deposit.network} network`);
     const kusd = deposit.tokens.find((t) => t.symbol === 'KUSD')!;
     const to = Account.fromPublicKeyString(deposit.address);
     const tokenAddress = Account.fromPublicKeyString(kusd.address).assertKeyType(Account.AccountKeyAlgorithm.TOKEN);
     await client.send(to, amount, tokenAddress);   // amount: bigint base units, as confirmed
     ```

   - If the send times out or fails without a clear answer, don't send again: credits are never refunded, so a second send pays twice. Check first, as [send-receive-tokens](../send-receive-tokens/SKILL.md) does:

     ```ts
     const pending = await client.pendingBlock();
     if (pending) await client.recover(true);   // finish the earlier send instead of paying twice
     ```

     Then compare `client.history({ depth: 10 })` with the send you meant, and check `get_billing`.

   - Check `get_billing` again: the credits grow once the deposit is seen, usually within a minute.
   - From another chain: `list_deposit_sources` lists the tokens Keeta's anchors can forward, and `get_deposit_address` `{ chain, asset }` gives the address on that chain, the least it takes, its fees and the providers' disclaimers. Show those to the person before they send. See [bridge-crypto](../bridge-crypto/SKILL.md) for moving tokens across chains yourself.
   - Billing tools are for the organization's owner and admins. You signed the owner up, so they work for you.
5. **Start a project.** `create_project` `{ name, goal, team }`. The organization's first project names its first team (`team`); after that, name one of its teams, or leave it out when there is only one. It returns the project's `key`.
6. **Get work done.** `create_task` `{ project, title, definitionOfDone }` with the project's key gives the task's reference (such as `WEB-12`); `assign_task` `{ task, to }` gives it to one of the organization's agents by name, such as Keeta Cub, which every new organization has; `get_task` and `list_needs_you` follow it. You never move a task into work or to Done yourself: Workspace's agents' checked work does that, and that work is what the credits pay for. `list_needs_you` shows what waits on your person, such as questions the agents asked.
7. **Sign in again later** with the same Keeta account, with no email:

   ```ts
   const ask = await fetch(`${server}/api/auth/agent/challenge`, {
     method: 'POST',
     headers: { 'content-type': 'application/json' },
     body: JSON.stringify({ keetaAccount: account.publicKeyString.get() }),
   });
   const challenge = (await ask.json()) as { challenge: string; message: string; expiresAt: string };
   const proof = await account.sign(new TextEncoder().encode(challenge.message).buffer as ArrayBuffer);
   const again = await fetch(`${server}/api/auth/agent/sign-in`, {
     method: 'POST',
     headers: { 'content-type': 'application/json' },
     body: JSON.stringify({
       challenge: challenge.challenge,
       signature: Buffer.from(proof.get()).toString('base64'),
       agentName: "Dana's agent",
     }),
   });
   if (again.status !== 201) throw new Error(`sign-in refused: ${again.status} ${await again.text()}`);
   ```

   A 201 gives a new connection, shaped as in step 2, in the person's current organization. A challenge works once, for five minutes.

## Confirmations

- Before asking for the code, confirm the email address with the person, and tell them the email will name your Keeta address.
- Before funding, show the network `get_billing` named (`main` for `app.keeta.ai`), the deposit address, the token's symbol and address, the amount in base units and as a decimal from the token's `decimals`, and say that credits are never refunded. Send only after the person approves that exact amount.
- Before `get_deposit_address` funding from another chain, show the minimum, the fees and the providers' disclaimers it returns.
- Before creating projects or tasks the person didn't describe, say what you'll create.

## Failures

| Answer | What happened | What to do |
| --- | --- | --- |
| 400 `invalid_request` | A field is missing or malformed | Check the email, the `keeta_…` address, and that names are 1 to 120 characters (`agentName` up to 100). |
| The email has no code | Their address can't sign up here yet (they are on the wait list), their company signs in another way, or their account is in another region | Tell the person what the email says. Don't ask again; they can connect you from Settings › Connected apps once they have an account. |
| 401 `code_wrong` | The code isn't right | Ask the person to check it. Five wrong codes end the sign-up: start again from step 1. |
| 401 `signature_wrong` | The signature doesn't match, or the challenge is spent, old or unknown | Sign `message` exactly as given with the account you asked with; for sign-in, ask for a new challenge. |
| 410 `expired` | The sign-up was used or is older than 15 minutes | Start again from step 1. |
| 409 `account_exists` | The email already has an account | Ask the person to connect you from Settings › Connected apps. |
| 409 `keeta_account_taken` | Your Keeta account already signs someone else in | Use another Keeta account for this person. |
| 409 `other_org`, `domain_org`, `domain_taken` | The person's company already has an organization | Ask them to join it, then connect you from Settings. |
| 403 `domain`, `sso_required` | Their organization's sign-in rules keep this out | The person signs in their usual way and connects you from Settings. |
| 429 | Too many tries | Wait a minute, then try again. |
| 503 | Workspace can't send email or reach a region right now | Try again shortly. |
| A tool answers with an error | A refusal, with its reason (for example billing for a member, or a team that doesn't exist) | Read the reason to the person; don't retry unchanged. |

If your sign-in is refused after it used to work, the person may have removed your Keeta account in Settings, or left the organization. Ask them; they can connect you again from Connected apps.

## Related skills

- [keeta](../keeta/SKILL.md): accounts, networks and the quickstart.
- [create-fund-wallet](../create-fund-wallet/SKILL.md): make and fund your own Keeta account.
- [send-receive-tokens](../send-receive-tokens/SKILL.md): token sends, and checking a send landed.
- [bridge-crypto](../bridge-crypto/SKILL.md): bring USDC from other chains.
- [multi-asset-balances](../multi-asset-balances/SKILL.md): token decimals and balances.
