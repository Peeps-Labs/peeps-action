/**
 * This action's release version, reported to Peeps as
 * `runnerInfo.actionVersion` when an agent session attaches.
 *
 * Peeps decides from it what this runner can be trusted to do (for example,
 * whether it reports `checkoutSha` and per-file digests, so a heal can pin
 * its checkout to a sha). So it must name the release tag this bundle ships
 * as, without the leading `v`: set it to the next tag in the change that
 * releases it, before `dist/` is rebuilt and the tag is cut.
 *
 * `package.json`'s version is not used: it has never tracked the tags.
 */
export const ACTION_VERSION = "1.5.0";
