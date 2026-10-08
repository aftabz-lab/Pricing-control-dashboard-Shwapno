# Pricing Control query error fix

## Upload

1. Extract this ZIP.
2. Open https://github.com/aftabz-lab/Pricing-control-dashboard-Shwapno on the `main` branch.
3. Choose **Add file → Upload files** at the repository root.
4. Upload and replace **powerbi.js** and **data.js**. Keep their names unchanged. Do not upload the ZIP itself.
5. Commit the upload, wait for GitHub Pages deployment to finish, then open https://aftabz-lab.github.io/Pricing-control-dashboard-Shwapno/ and press **Ctrl+F5**.
6. Apply the same date range and **All categories** selection to confirm the detail loads.

## Change

The public Power BI source rejected the broad detail query with `rsQueryMemoryLimitExceeded`. The patch recovers that query by reading the complete original row keys and retrieving the original source measures in smaller batches. It keeps the original filters, grouping, source headlines, price measures, sorting and continuation pages. A missing detail row or a source refresh during recovery rejects the entire candidate view, preserving the last valid view.

Only the two JavaScript files above are changed. Fonts, layout, dashboard calculations, exports, signatures, filters, snapshot files, watcher configuration and snapshot timing are unchanged.

Broad selections can take a few minutes to finish loading every source row.

## Checks

- All 30 automated checks passed.
- Static site build and JavaScript syntax checks passed.
- Exact source-row comparisons passed for buying detail, DC detail, selling detail and daily selling detail.
- The complete **All categories** buying view loaded successfully from the live source, with no duplicate detail rows.
- Every other tracked repository file was verified unchanged.
