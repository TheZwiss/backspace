import React, { useId, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import type { InstanceInfoResponse } from '@backspace/shared';
import { SourceCodeLink } from '../ui/SourceCodeLink';

/**
 * "This instance": which server the user is on, set apart from the project
 * cards so nobody reads the Support card as paying this server's admin.
 *
 * The name comes from the instance info and the domain from the address bar.
 * The source offer is the existing AGPL section 13 link, which carries the
 * running version and commit and points at a fork's own source when the
 * operator configured one; nothing else here repeats the version. While the
 * info is loading, or when it failed, the domain stands alone.
 */
export function InstanceSection(props: { info: InstanceInfoResponse | null }): JSX.Element {
  const { info } = props;
  const { t } = useTranslation('project');
  const titleId = useId();

  return (
    <section aria-labelledby={titleId}>
      <h2 id={titleId} className="mb-2 text-xs font-semibold uppercase tracking-wider text-txt-tertiary">
        {t('instance.title')}
      </h2>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {info && <span className="text-sm font-semibold text-txt-primary break-words min-w-0">{info.name}</span>}
        <span className="text-sm text-txt-secondary break-all">{window.location.host}</span>
        {info && (
          <SourceCodeLink sourceCodeUrl={info.sourceCodeUrl} version={info.version} commit={info.commit} />
        )}
      </div>
    </section>
  );
}
