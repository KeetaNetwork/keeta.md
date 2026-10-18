/*
 * Names the skills' TypeScript blocks use without defining them: the context an earlier block
 * on the same page sets up (a client, an account, a provider) and values the reader supplies
 * (a recipient, an amount). A block that declares one of these names itself shadows it here.
 */
import type * as KeetaNetModule from '@keetanetwork/keetanet-client';
import type * as KeetaAnchorModule from '@keetanetwork/anchor';
import type { AnchorChaining as AnchorChainingClass } from '@keetanetwork/anchor/lib/chaining.js';
import type { Errors as AssetMovementErrors } from '@keetanetwork/anchor/services/asset-movement/common.js';
import type { Errors as FXErrorsModule } from '@keetanetwork/anchor/services/fx/common.js';
import type { GenericAccount, TokenAddress, StorageAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import type { FacilitatorClient } from '@x402/core/server';

type UserClient = KeetaNetModule.UserClient;
type Account = ReturnType<typeof KeetaNetModule.lib.Account.fromSeed>;
type AssetMovementClient = InstanceType<typeof KeetaAnchorModule.AssetMovement.Client>;
type AssetMovementProvider = NonNullable<Awaited<ReturnType<AssetMovementClient['getProvidersForTransfer']>>>[number];
type AssetMovementTransfer = Awaited<ReturnType<AssetMovementProvider['initiateTransfer']>>;
type KYCClient = InstanceType<typeof KeetaAnchorModule.KYC.Client>;
type KYCVerification = Awaited<ReturnType<KYCClient['createVerification']>>[number];
type FXClient = InstanceType<typeof KeetaAnchorModule.FX.Client>;
type Certificate = InstanceType<typeof KeetaAnchorModule.lib.Certificates.Certificate>;

declare global {
	// Modules a page imports once near the top.
	const KeetaNet: typeof KeetaNetModule;
	const KeetaAnchor: typeof KeetaAnchorModule;
	const Account: typeof KeetaNetModule.lib.Account;
	const Block: typeof KeetaNetModule.lib.Block;
	const Permissions: typeof KeetaNetModule.lib.Permissions;
	const Errors: typeof AssetMovementErrors;
	const FXErrors: typeof FXErrorsModule;

	// The connected client and its account.
	const client: UserClient;
	const resolver: InstanceType<typeof KeetaAnchorModule.lib.Resolver>;
	const account: Account;
	const me: Account;
	const keeta: `chain:keeta:${bigint}`;
	const base: 'chain:evm:8453' | 'chain:evm:84532';

	// Clients and providers an earlier block created.
	const am: AssetMovementClient;
	const chaining: AnchorChainingClass;
	const provider: AssetMovementProvider;
	const providers: AssetMovementProvider[];
	const transfer: AssetMovementTransfer;
	const fx: FXClient;
	const quotes: NonNullable<Awaited<ReturnType<FXClient['getQuotes']>>>;
	const verification: KYCVerification;
	const facilitatorClient: FacilitatorClient;
	const approvedProviderID: string;
	const approvedPlan: number;

	// Tokens.
	const token: TokenAddress;
	const tokenA: TokenAddress;
	const tokenB: TokenAddress;
	const usdc: TokenAddress;
	const keetaUSDC: TokenAddress;
	const keetaUSD: TokenAddress;
	const keetaEUR: TokenAddress;
	const usdToken: TokenAddress;
	const tokenAddress: string;

	// Other accounts.
	const recipient: GenericAccount;
	const recipientAddress: string;
	const sender: Account;
	const alice: Account;
	const bob: Account;
	const aliceClient: UserClient;
	const bobClient: UserClient;
	const operator: GenericAccount;
	const minter: GenericAccount;
	const holder: GenericAccount;
	const teammate: GenericAccount;
	const agentAccount: GenericAccount;
	const otherAccount: GenericAccount;
	const vault: StorageAddress;
	const vaultAccount: StorageAddress;
	const entity: GenericAccount;
	const address: string;
	const evmRecipient: `0x${string}`;
	const clabe: string;

	// Values the reader supplies.
	const amount: bigint;
	const cents: bigint;
	const delta: bigint;
	const budgetBaseUnits: bigint;
	const invoiceId: string;
	const externalIdentifier: string;
	const templateId: string;
	const firstName: string;
	const lastName: string;
	const signedAgreementId: string;
	const pem: string;
	const intermediatePems: string[];
	const certs: Awaited<ReturnType<KYCVerification['getCertificates']>>;
	const cert: Certificate;
	const neededAttributes: Parameters<typeof KeetaAnchorModule.lib.Certificates.SharableCertificateAttributes.fromCertificate>[2];
	const shareWithPrincipals: GenericAccount[];
	const sharable: InstanceType<typeof KeetaAnchorModule.lib.Certificates.SharableCertificateAttributes>;
	const card: { type: 'persistent-address-template'; persistentAddressTemplateId: string };

	// Approval prompts the agent shows a human.
	function tokenFor(ticker: Parameters<InstanceType<typeof KeetaAnchorModule.lib.Resolver>['lookupToken']>[0]): Promise<TokenAddress>;
	function askApproval(question: string): Promise<boolean>;
	function requestApproval(...details: unknown[]): Promise<boolean>;
}

export {};
