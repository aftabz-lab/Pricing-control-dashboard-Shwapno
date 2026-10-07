# SHWAPNO Pricing Control

A management dashboard for the published **Over Buying Price** and **Under Sale Price** report, with current RHO / Zonal ownership from Zone Distribution.

## Start here

1. Create a **public** GitHub repository named **`pricing-control-dashboard-shwapno`** under `aftabz-lab`.
2. Extract `SHWAPNO_Pricing_Control_New_Repository.zip`. Upload its **contents** to the repository root on the **`main`** branch. Do not upload the ZIP itself or place everything inside another folder. Include `.github/workflows/update-snapshot.yml`.
3. In the new repository, open **Settings → Pages → Build and deployment → Source → GitHub Actions**.
4. Open **Actions → Refresh snapshot and publish dashboard → Run workflow**. Select `main`, leave **force** checked, and run it. The deployment step publishes the dashboard; its output supplies the live URL.
5. Install the separate watcher from **`SHWAPNO_Pricing_Control_PowerBI_Watcher_Apps_Script.zip`**. Follow that ZIP's `SETUP.md`. **Do not upload the watcher ZIP or `Code.gs` to this GitHub repository.**

If the first run started before Pages was enabled, enable Pages as above and run the workflow again. No npm install, web server, Power BI sign-in or service-account credential is required.

If the `.github` folder is missing after a browser upload, choose **Add file → Create new file**, enter `.github/workflows/update-snapshot.yml`, and paste the exact supplied workflow. Commit it to `main`.

## Snapshot rules

This repository carries the Receiving dashboard's refresh cadence:

| Rule | Behaviour |
| --- | --- |
| Source-change watcher | Separate Google Apps Script checks every minute and sends `power_bi_report_updated` when the report marker or data fingerprint changes. |
| Hourly safety snapshot | Watcher dispatches after one hour even if the marker is unchanged; the GitHub worker also rebuilds snapshots aged one hour. |
| GitHub fallback | Scheduled check every five minutes (`2-59/5 * * * *`). |
| Open dashboard | Checks the published status every minute and loads newer validated data. |
| Manual Refresh | Checks the latest shared snapshot. It does not label an old source refresh as a new Power BI refresh. |
| Failed or partial extraction | Retains the last validated snapshot. A failed run publishes failure status separately. |
| Stale date slicer | Probes actual source facts through the current Dhaka date and extends the source end date when newer facts are present. |
| Stale cached snapshot | An older source timestamp or earlier data end date cannot replace a newer validated copy. |
| Snapshot consistency | Model marker and actual source totals must remain the same before and after extraction. |
| Deployment | The same workflow explicitly publishes the Pages artifact after updating the snapshot. Automated bot commits alone are not relied on to trigger Pages. |

“Every minute” is the detection cadence. GitHub queue time, extraction, Google trigger timing and Pages deployment add time before publication; this is not a zero-delay Power BI webhook. Scheduled GitHub runs can also be delayed. The watcher must be installed and its token must remain valid.

## Management views

- Executive overview: source incidents, source margins, benchmark gap, daily source comparison and outlet review priorities.
- RHO & Zonal: current ownership, sortable summaries and leader CSV exports.
- Outlet exceptions: summary plus original-grain price detail, frozen outlet code / name columns and black sorting arrows.
- Article intelligence: article contribution, outlet coverage and source prices.
- Separate DC comparison for over buying and original daily detail for under sale.
- Snapshot & rules: actual source freshness and calculation definitions.

Searchable multi-selection filters include Division / Region, RHO, Zonal, outlets, master category, subcategory and articles. **Select all matching** selects every search match, including options beyond the first 150 displayed. Pressing Enter in a filter search does the same. Choose **Apply scope** to query all figures and details in that scope. **All / clear** means all available values. The default categories, date window and parameter values are read from the saved report.

The dashboard starts with a real validated snapshot. New filter contexts are queried directly from the same public Power BI model. If a query fails, the last valid view is retained and the displayed controls are restored to its scope.

## Calculation fidelity

- The buying headline uses **Over Pricing Total Incident**, at **Day–Outlet–Article** level.
- The under-sale headline uses **Under Pricing Total Incident**, at **Outlet–Article over the selected period** level.
- Eligible detail uses the source deviation and the **strict** source quantity floor: quantity **greater than** the floor, not greater than or equal. Default source parameters are 5% and quantity 2.
- Source detail projections are preserved. Additional hierarchy columns are joined after querying; adding a region to a source price grouping can change its benchmark and is deliberately avoided.
- Unit prices, benchmarks, incident rates and margins are Power BI measures. The source summary card provides the under-sale margin and rounded average margin.
- **Indicative benchmark gap** = quantity × positive source unit price difference. It is a review aid, **not an accounting loss**.
- DC comparison retains the source DC table's `DK11` / `DK14`, nonblank article and positive receiving-quantity filters. Its original benchmark is retained and its rows are not added to the outlet headline.
- Under-sale daily detail retains the source table's fixed deviation **below −20%**. It is not added to the periodic incident headline.
- Missing source outlet codes are displayed as **Not supplied**, kept in totals and retained as blank in the export's **Original source outlet code** column. Missing hierarchy is labelled **Not mapped**. Conflicting owners are identified explicitly.
- Source headline and detail-row counts are displayed separately if they differ in a selected filter context. They are never silently substituted for each other.

**Management Excel** exports eight sheets for the currently applied mode and scope: overview, outlet, RHO, Zonal, article, periodic / buying exceptions, separate DC / daily comparison, and daily trend. Table CSVs contain all matching sorted rows, including rows beyond the current page.

## Connections

Power BI: the requested pricing report whose resource key is `75ef8b89-32cc-42e4-869d-7f688be09807`.

RHO / Zonal: the published Zone Distribution snapshot used by the existing dashboards. Both current lowercase and legacy Excel-style column names are supported. It joins only by normalised outlet code. The browser also checks for newer hierarchy data independently of the Power BI snapshot.

If you choose another repository name, edit `repository` in `settings.js` and in the separate watcher's `Code.gs`. Optional repository variables `PBI_EMBED_URL` and `PBI_API_ROOT` override the worker's source connection; the frontend `settings.js` and watcher properties must use the same source if you change it.

## Local verification

Node.js 20 or later is sufficient. There are no package dependencies.

```sh
npm test
FORCE_SNAPSHOT=1 npm run snapshot
npm run build
```

`npm run build` prepares `_site` with only the browser files and validated snapshot. Serve `_site` with an HTTP server for a local preview; module files should not be opened directly from a device file path.

The existing Receiving, Feasibility, Credit Card and Zone Distribution repositories are not modified by this package.
