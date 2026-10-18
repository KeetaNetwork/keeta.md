# Identity: certificates, selective disclosure, encryption and signed requests

Every code block here typechecks against `@keetanetwork/keetanet-client` 0.18.8 and `@keetanetwork/anchor` 0.0.104.

## Certificates on accounts

Keeta accounts can carry X.509 certificates, for example a KYC certificate (a person) or a KYB certificate (a business) issued by an identity anchor.

- A certificate's subject key must match the account that carries it.
- Sensitive attributes are encrypted to the subject. Only commitments to them are visible on-chain.
- The network doesn't decide whom to trust. Each anchor or app chooses which issuers it accepts.

```ts
const mine = await client.getCertificates();                      // [{ certificate, intermediates }]
const theirs = await client.client.getAllCertificates(otherAccount);
for (const { certificate, intermediates } of mine) {
  console.log(certificate.subject, certificate.issuer, certificate.notAfter.toISOString(),
    certificate.checkValid(), certificate.hash().toString(), intermediates?.getCertificates().length ?? 0);
}

const { Certificate, CertificateBundle } = KeetaNet.lib.Utils.Certificate;
const cert = new Certificate(pem);
const bundle = intermediatePems.length ? new CertificateBundle(intermediatePems) : null;
await client.modifyCertificate(KeetaNet.lib.Block.AdjustMethod.ADD, cert, bundle);   // attach (with consent)
await client.modifyCertificate(KeetaNet.lib.Block.AdjustMethod.SUBTRACT, cert.hash()); // remove by hash
```

- To get a certificate, use the [complete-kyc](../../complete-kyc/SKILL.md) skill for a person or [complete-kyb](../../complete-kyb/SKILL.md) for a business.
- On the test network, KYC certificates chain to "Keeta Test Network KYC Root CA".
- Check the issuer, subject, validity period and intermediates before you attach a certificate or rely on one.

## Share only what is asked (selective disclosure)

When an anchor raises `KYCShareNeeded`, it lists the attributes it needs (`neededAttributes`), who should receive them (`shareWithPrincipals`), and which certificate issuers it trusts (`acceptedIssuers`). Pick a certificate those issuers signed, then share exactly those attributes, after the user consents:

```ts
import * as KeetaAnchor from '@keetanetwork/anchor';
import { Errors } from '@keetanetwork/anchor/services/asset-movement/common.js';

const { Certificate, SharableCertificateAttributes } = KeetaAnchor.lib.Certificates;
type DN = { name: string; value: string }[];
const sameDN = (a: DN, b: DN) => a.length === b.length && a.every(({ name, value }) => b.some((part) => part.name === name && part.value === value));

try {
  await provider.initiateTransfer(request);                    // or whichever call raised it
} catch (error) {
  if (!Errors.KYCShareNeeded.isInstance(error)) throw error;

  // acceptedIssuers holds the subject DNs of issuers the provider trusts ("any of"). A certificate
  // qualifies when one of them signed it or appears in its chain. An empty list accepts any issuer.
  const records = await client.client.getAllCertificates(account);
  const record = records.find(({ certificate, intermediates }) => {
    const chain: DN[] = [certificate.issuerDN, ...(intermediates?.getCertificates() ?? []).flatMap((cert) => [cert.subjectDN, cert.issuerDN])];
    return error.acceptedIssuers.length === 0 || error.acceptedIssuers.some((dn) => chain.some((link) => sameDN(dn, link)));
  });
  if (!record) throw new Error('no certificate from an issuer this provider accepts: complete KYC with one it lists');

  // Share only the named attributes. With no list, the provider gets every attribute, so ask about that first.
  if (!error.neededAttributes) throw new Error('the provider named no attributes: confirm before sharing the whole certificate');
  const names = error.neededAttributes.map((name) => {
    KeetaAnchor.lib.Certificates.SharableCertificateAttributes.assertCertificateAttributeName(name);   // throws on a name the SDK doesn't know
    return name;
  });

  const cert = new Certificate(record.certificate.toPEM(), { subjectKey: account });
  const intermediates = record.intermediates ? new Set(record.intermediates.getCertificates()) : undefined;
  const sharable = await SharableCertificateAttributes.fromCertificate(cert, intermediates, names);
  for (const principal of error.shareWithPrincipals) await sharable.grantAccess(principal);
  await provider.shareKYCAttributes({ account, attributes: sharable });   // then retry the original call
}
```

Show the user the provider, the attribute names and the principals before `shareKYCAttributes`, and wait for consent. The task skills call this block, wrapped as a function of the error, `shareRequestedKYC(error)`.

Opening a certificate with `subjectKey: account` decrypts its sensitive attributes locally. Keep the decrypted values out of logs, prompts and on-chain fields.

**Terms of service.** When `KYCShareNeeded` includes `tosFlow`, as Bridge.xyz's does, a person accepts the provider's terms at `tosFlow.url` first. The page hands the agreement ID (`signedAgreementId`) to the app that embeds it, and the share must carry it. If you can't embed the page and receive the ID, stop; never invent one:

```ts
await provider.shareKYCAttributes({ account, attributes: sharable, tosAgreement: { id: signedAgreementId } });
```

## Certificate-gated anchors

Username, storage and notification anchors can require a certificate from accepted issuers. They then fail with `KeetaAnchorCertificateRequiredError`, which you can import from `@keetanetwork/anchor/lib/error.js`:

- **`kind: 'missing'` (HTTP 401):** the signer has no published certificate.
- **`kind: 'untrusted'` (HTTP 403):** its certificate chain isn't trusted.
- **`acceptedIssuers`:** lists acceptable issuer names. The outer list means "any of"; each inner list means "all of".

Get a certificate from an accepted issuer and attach it, then retry.

## Encrypt data to accounts

`EncryptedContainer` encrypts a payload to one or more Keeta accounts, and can optionally sign it:

```ts
const { EncryptedContainer } = KeetaAnchor.lib;
const box = EncryptedContainer.fromPlaintext(JSON.stringify({ invoice: 1001 }), [recipient], { signer: sender, locked: false });
const wire: ArrayBuffer = await box.getEncodedBuffer();                 // send or store this
const opened = EncryptedContainer.fromEncodedBuffer(wire, [recipient]); // needs the recipient's private key
const text = Buffer.from(await opened.getPlaintext()).toString('utf-8');
const authentic = opened.isSigned ? await opened.verifySignature() : false;
```

The storage anchor uses these containers. Accounts backed by a Ledger hardware wallet cannot decrypt them.

## Signed requests

Anchors authenticate requests with account signatures. Use the same scheme for your own services:

```ts
import { SignData, VerifySignedData } from '@keetanetwork/anchor/lib/utils/signing.js';

const signable = ['my-service', 'GET_INVOICE', invoiceId, account];         // strings, numbers, bigints, accounts
const signed = await SignData(account, signable);                          // { nonce, timestamp, signature }
const ok = await VerifySignedData(account, signable, signed, { maxSkewMs: 300_000 });
```

- Verification allows about five minutes of clock skew, so keep clocks synced.
- Store nonces you have already seen, to reject replays.
