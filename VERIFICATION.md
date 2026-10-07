# Package verification

The repository was built and checked before packaging.

- Source reconciliation: **1,303** over-buying incidents and **576** under-sale incidents, with separate original-source DC and daily comparisons.
- The included snapshot covers **6 September–6 October 2026**. Its actual source refresh time and snapshot generation time are retained in the data.
- **1,032** outlet hierarchy records loaded from the published Zone Distribution source.
- **11 source-rule tests passed**, including the original price grain, strict quantity/deviation thresholds, missing outlet handling, hierarchy joins, safe exports and protection against older snapshots.
- Dashboard interaction checks passed: theme, mode switching, all views, sorting, pagination, table search, outlet drill-down, matching article selection and multiple RHO selection.
- Both Management Excel exports open successfully and contain eight sheets, with detail counts matching the included snapshot.
- The separate watcher passed checks for one-minute installation, unchanged-source suppression, hourly safety, failed-dispatch retry and removal of its own trigger.
- The static Pages build passed.

Browser visual preview was unavailable in the build environment. Check desktop and mobile layout after deploying through GitHub Actions. The new repository and watcher are supplied for your installation; they have not been published or installed on your account.
