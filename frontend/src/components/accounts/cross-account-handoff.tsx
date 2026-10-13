import { Info, ShieldCheck } from 'lucide-react';
import { CopyButton } from '@/components/ui/copy-button';
import {
  ACCOUNT_PREREQUISITES,
  COST_READER_ROLE_NAME,
  DEPLOY_ACCOUNT_KNOWN,
  costReaderArn,
  deployAccountLabel,
  handoffText,
  permissionsPolicyJson,
  rootPathNote,
  trustPolicyJson,
} from '@/lib/aws-onboarding';

/**
 * The half of the job that happens in someone else's account.
 *
 * Rendered as copyable text rather than described in prose, because its
 * entire purpose is to be sent to another team.
 *
 * Lifted out of `connect-dialog.tsx` when the edit dialog arrived.
 * Editing an ExternalId is rotating it, which invalidates the trust
 * policy already applied in the target account -- so the same block of
 * values has to be re-sendable from the edit dialog, and two copies of
 * it would be two things to keep in step. Nothing about it changed in
 * the move.
 */
export function CrossAccountHandoff({
  accountId,
  externalId,
}: {
  accountId: string;
  externalId: string;
}) {
  const target = accountId === '' ? '<ACCOUNT_ID>' : accountId;
  const permissions = permissionsPolicyJson();
  const trust = trustPolicyJson(externalId);

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
            What the other account&apos;s administrator must do
          </p>
          <p className="text-xs text-muted-foreground">
            Send them this. CostHub cannot create anything in an account it does not own, so until
            the role exists the connection will be registered but imports will fail with
            AccessDenied.
          </p>
        </div>
        {externalId !== '' && (
          <CopyButton value={handoffText(target, externalId)} label="Copy all" />
        )}
      </div>

      <dl className="space-y-1.5 text-xs">
        <Pair term="Role name" value={COST_READER_ROLE_NAME} note="exactly this name" />
        <Pair term="Role ARN" value={costReaderArn(target)} />
        <Pair term="Trusts account" value={deployAccountLabel()} />
        <Pair term="ExternalId" value={externalId || 'could not be generated'} />
      </dl>

      <p className="text-[11px] text-muted-foreground">{rootPathNote(target)}</p>

      {/* These two are not IAM and are easy to leave out of a relayed
          message, but a perfectly correct role still returns
          AccessDenied on every cost API without the first one. They
          were in the copied text only; now they are on screen too. */}
      <div className="space-y-1">
        <p className="text-xs font-medium">Also required in that account, once</p>
        <ol className="list-decimal space-y-1 pl-4 text-[11px] text-muted-foreground">
          {ACCOUNT_PREREQUISITES.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      </div>

      {externalId !== '' && (
        <p className="flex items-start gap-2 rounded border border-warning/40 bg-warning/10 px-2.5 py-2 text-[11px]">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            Send this ExternalId to the other account&rsquo;s administrator &mdash; their trust
            policy has to contain this exact value. It stays readable on the Cloud accounts
            screen, so you can look it up again rather than re-registering the account.
          </span>
        </p>
      )}

      {!DEPLOY_ACCOUNT_KNOWN && (
        <p className="text-[11px] text-warning">
          <code className="font-mono">NEXT_PUBLIC_DEPLOY_ACCOUNT_ID</code> is not set in this build,
          so the trust policy below carries a placeholder instead of this stack&apos;s account id.
          Replace it before sending. Run <code className="font-mono">./do.sh outputs dev</code> for
          local dev, or set the variable in the Amplify console for the deployed site.
        </p>
      )}

      <PolicyBlock title="Permissions policy" json={permissions} />
      <PolicyBlock title="Trust policy" json={trust} />

      <p className="text-[11px] text-muted-foreground">
        Nothing is needed on this side: the CostHub execution role is already permitted to assume a
        role named <code className="font-mono">{COST_READER_ROLE_NAME}</code> in{' '}
        <strong className="font-medium">any</strong> AWS account, so no Terraform change and no
        redeploy is involved in adding an account.
      </p>
    </div>
  );
}

function Pair({ term, value, note }: { term: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-28 shrink-0 text-muted-foreground">{term}</dt>
      <dd className="min-w-0 flex-1 break-all font-mono">{value}</dd>
      {note && <span className="shrink-0 text-[10px] text-muted-foreground">{note}</span>}
    </div>
  );
}

function PolicyBlock({ title, json }: { title: string; json: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">{title}</p>
        <CopyButton value={json} />
      </div>
      <pre className="max-h-44 overflow-auto rounded border bg-card p-2.5 font-mono text-[11px] leading-relaxed">
        {json}
      </pre>
    </div>
  );
}
