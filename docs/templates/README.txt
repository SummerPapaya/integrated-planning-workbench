Integrated Planning Workbench / CSV templates

All files use UTF-8. Dates use YYYY-MM-DD. One inventory snapshot date is expected.
Use the same location and SKU IDs in every file. Do not include thousands separators.

Required:
- sales.csv: date, location, sku, units, net_sales, cogs. Negative units represent returns and are excluded from demand; amounts and costs must be populated on every row.
- inventory.csv: as_of, location, sku, on_hand. available_units and unit_cost are optional columns. If available_units is present, PSI uses it as the plan-ready quantity; it must be between 0 and on_hand. If absent, PSI uses on_hand as an explicitly labeled proxy, and uploaded-data action export is paused. Inventory value still uses physical on_hand.
- products.csv: sku, major_category, category, name. major_category is the business major category (e.g. Junior Apparel); category is its product line. unit_cost, lead_time_days, case_pack and min_order_qty are optional; missing lead time or supplier constraints are shown as assumptions.

As needed:
- inbound.csv: eta, location, sku, units. po_id is optional. Past ETA is flagged overdue and not treated as received.
- promotions.csv: promo_id, start_date, end_date, location, sku. Validated and shown as coverage evidence; no uplift is inferred.
- actuals.csv: date, location, sku, sold_units, open_hours, out_of_stock_hours. observed_unmet_units is optional and must be measured externally, not estimated by this app. Dates are after the inventory snapshot and no later than today. Sales on stockout days without measured unmet units are excluded from future forecast accuracy comparison.
- executions.csv: scenario_id, location, sku, ordered_units, eta, received_units, receipt_date. po_id is optional. Use the exact scenario_id from the exported App01 action/register CSV. Receipt date is blank until received_units is positive. Matching is by scenario_id and location/SKU.

An empty inbound file still requires the explicit "no open inbound" confirmation in the app. A populated inbound file must cover all open receipts in the planning scope. Omitting both blocks action export in uploaded-data mode.

The three P1 evidence files are loaded separately after the core planning files. They do not alter the scenario ID or automatically retrain the forecast. All processing happens in your browser session. CSV exports are proposal records, not purchase orders. Verify IDs, units, sellable stock, supplier constraints, and approvals in your systems of record.
