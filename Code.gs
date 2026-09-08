/**
 * ==========================================================================
 *  SJ Physiotherapy - BILLING & SALES ANALYSIS SYSTEM
 *  Backend: Google Apps Script  (acts as the API + database layer)
 *  Database: Google Sheets (this bound spreadsheet)
 *  Payments: Razorpay UPI QR Codes API + Webhook
 * ==========================================================================
 *  HOW THIS FILE WORKS
 *  - doGet(e)  -> handles read-only requests  (?action=...)
 *  - doPost(e) -> handles two kinds of traffic on the SAME url:
 *       1) Normal app requests from the website  (JSON body: {action, payload})
 *       2) Razorpay webhook calls (identified by ?token=WEBHOOK_TOKEN)
 *  - Run setupDatabase() ONCE from the Apps Script editor to create all
 *    sheets, headers and default rows. See SETUP_GUIDE.md for full steps.
 * ==========================================================================
 */

// ---------------------------------------------------------------------------
// 0. CONFIG - you will fill the Razorpay keys into the Settings sheet later,
//    NOT here. Nothing secret is hard-coded in this file.
// ---------------------------------------------------------------------------
const SHEET = {
  SETTINGS: 'Settings',
  BILLERS: 'Billers',
  CUSTOMERS: 'Customers',
  PRODUCTS: 'Products',
  BILLS: 'Bills',
  BILL_ITEMS: 'BillItems',
  PAYMENT_LOGS: 'PaymentLogs',
  DASHBOARD: 'Dashboard',
  STOCK_LOG: 'StockLog',
  UNIVERSAL_REPORT: 'UniversalReport',
  DAILY_REPORT: 'DailyReport',
  CUSTOM_CHARTS: 'CustomCharts'
};

// Bump this string every time you paste updated code into the Apps Script
// editor. The frontend compares it against its own expected value and shows
// an on-screen warning if they don't match - the single most reliable way
// to prove whether a NEW DEPLOYMENT actually picked up your latest code
// (saving the file alone does NOT update the live /exec URL - see
// Deploy > Manage deployments > pencil icon > Version: New version > Deploy).
const BACKEND_BUILD = 'SJP-2026-09-08-01-FIX';

// ---------------------------------------------------------------------------
// 0b. SCHEMA MIGRATIONS - runs automatically on every request (cheap
//     no-op once caught up) so an EXISTING spreadsheet gets the new Stock /
//     Biller-permission columns without anyone having to re-run
//     setupDatabase() by hand. Never destructive - only appends columns
//     and sheets that are missing.
// ---------------------------------------------------------------------------
const SCHEMA_VERSION = 8;

// Theme customization - Super Admin only, applied live across the whole
// app (sidebar, buttons, charts, bill header). Stored as plain Settings
// key/value rows like everything else, so no separate sheet is needed.
// Defaults exactly match the CSS's own hardcoded fallback colors, so a
// spreadsheet that has never customized anything looks byte-for-byte the
// same as before this feature existed.
const THEME_SETTING_DEFAULTS = [
  ['ThemeButtonStyle', 'gradient-diagonal'],
  ['ThemeButtonFrom', '#a8d339'],
  ['ThemeButtonTo', '#2778b7'],
  ['ThemeButtonText', '#FFFFFF'],
  ['ThemeSidebarStyle', 'gradient-vertical'],
  ['ThemeSidebarFrom', '#a8d339'],
  ['ThemeSidebarTo', '#2778b7'],
  ['ThemeSidebarText', '#FFFFFF'],
  ['ThemeNavActiveBg', '#FFFFFF'],
  ['ThemeNavActiveText', '#a8d339'],
  ['ThemeBillHeaderColor', '#04bd07'],
  ['ThemeHeadingColor', '#182322'],
  ['ThemeMutedColor', '#4B5A57'],
  ['ThemeBgColor', '#F6F4F3'],
  ['ThemeSurfaceColor', '#FFFFFF'],
  ['ThemeBorderColor', '#E7DCD8'],
  ['ThemeChartPalette', '#a8d339,#2778b7,#59ff4d,#1F9E78,#2E86AB,#6C4FB6,#3D5A80,#8C2F39,#D4A017,#4B5A57,#7A5C61,#2be42e'],

  ['ThemeLoginBgStyle', 'gradient-diagonal'],
  ['ThemeLoginBgFrom', '#a8d339'],
  ['ThemeLoginBgTo', '#2778b7'],
  ['ThemeLoginCardBg', '#FFFFFF'],
  ['ThemeLoginHeadingColor', '#182322'],
  ['ThemeLoginTextColor', '#4B5A57'],

  ['ThemePageHeadingColor', '#182322'],
  ['ThemePageSubheadingColor', '#4B5A57'],
  ['ThemeSectionHeadingColor', '#182322'],

  ['ThemeTabActiveTextColor', '#a8d339'],
  ['ThemeTabInactiveTextColor', '#4B5A57'],
  ['ThemeTabIndicatorStyle', 'gradient-diagonal'],
  ['ThemeTabIndicatorFrom', '#a8d339'],
  ['ThemeTabIndicatorTo', '#2778b7'],

  ['ThemeGateBgColor', '#FBF1DC'],
  ['ThemeGateBorderColor', '#E8C766'],
  ['ThemeGateTitleColor', '#C68A1E'],

  ['ThemeBillCompanyNameBold', 'TRUE'],
  ['ThemeBillCompanyNameItalic', 'FALSE'],
  ['ThemeBillCompanyNameUnderline', 'FALSE'],
  ['ThemeBillCompanyInfoBold', 'FALSE'],
  ['ThemeBillCompanyInfoItalic', 'FALSE'],
  ['ThemeBillCompanyInfoUnderline', 'FALSE'],
  ['ThemeBillHeaderLayout', 'logo-side']
];

// Custom dashboard charts - Super Admin builds these on top of the fixed
// default widgets. See apiGetCustomChartData_ for exactly what each column
// means and how the data gets aggregated.
const CUSTOM_CHARTS_HEADERS = ['ChartID', 'Name', 'Type', 'DataSource', 'Dimension', 'Metric', 'MetricField', 'TopN', 'SortDir', 'SortOrder', 'CreatedAt', 'Color'];

// StockLog columns. PerformerRole/Name/Id are the clean, structured fields
// every write should use going forward - PerformedBy is kept only as a
// human-readable combined label for anyone glancing at the raw sheet.
const STOCK_LOG_HEADERS = [
  'Timestamp', 'ProductID', 'ProductName', 'ChangeType', 'Delta', 'NewStock', 'BillID',
  'PerformedBy', 'PerformerRole', 'PerformerName', 'PerformerId'
];

// Best-effort parse of the OLD combined "PerformedBy" text, used once by
// the migration below to backfill historical rows into the new structured
// columns. Handles every format this app has ever written into that
// column, including the buggy one (a Biller's own sale, which used to be
// logged as plain "Name (ID)" with no role prefix at all).
function parseLegacyPerformedBy_(s) {
  s = String(s || '').trim();
  if (!s) return { role: 'System', name: 'System', id: '' };
  let m = s.match(/^Biller:\s*(.+?)\s*\(([^)]+)\)\s*$/);
  if (m) return { role: 'Biller', name: m[1].trim(), id: m[2].trim() };
  m = s.match(/^Super Admin\s*\(([^)]*)\)\s*$/);
  if (m) return { role: 'Super Admin', name: 'Super Admin', id: '' };
  m = s.match(/^System\b/);
  if (m) return { role: 'System', name: s, id: '' };
  // Fallback: "Name (ID)" with no role prefix - the format the bug wrote
  // for a Biller's own sale, so treat any remaining "text (text)" shape as
  // a Biller entry.
  m = s.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (m) return { role: 'Biller', name: m[1].trim(), id: m[2].trim() };
  return { role: 'System', name: s, id: '' };
}

function migrateSchema_() {
  const props = PropertiesService.getScriptProperties();
  const current = Number(props.getProperty('SchemaVersion') || '1');
  if (current >= SCHEMA_VERSION) return;

  const ssRef = ss_();

  // --- Products: add Stock + LowStockThreshold columns if missing ---
  const productsSh = ssRef.getSheetByName(SHEET.PRODUCTS);
  if (productsSh && productsSh.getLastColumn() > 0) {
    let headers = productsSh.getRange(1, 1, 1, productsSh.getLastColumn()).getValues()[0];
    if (headers.indexOf('Stock') === -1) {
      const col = productsSh.getLastColumn() + 1;
      productsSh.getRange(1, col).setValue('Stock').setFontWeight('bold').setBackground('#E1341E').setFontColor('#FFFFFF');
    }
    headers = productsSh.getRange(1, 1, 1, productsSh.getLastColumn()).getValues()[0];
    if (headers.indexOf('LowStockThreshold') === -1) {
      const col = productsSh.getLastColumn() + 1;
      productsSh.getRange(1, col).setValue('LowStockThreshold').setFontWeight('bold').setBackground('#E1341E').setFontColor('#FFFFFF');
    }
  }

  // --- Billers: add CanAccessStockView + CanAccessStockEdit columns if missing ---
  const billersSh = ssRef.getSheetByName(SHEET.BILLERS);
  if (billersSh && billersSh.getLastColumn() > 0) {
    let headers = billersSh.getRange(1, 1, 1, billersSh.getLastColumn()).getValues()[0];
    if (headers.indexOf('CanAccessStockView') === -1) {
      const col = billersSh.getLastColumn() + 1;
      billersSh.getRange(1, col).setValue('CanAccessStockView').setFontWeight('bold').setBackground('#E1341E').setFontColor('#FFFFFF');
      if (billersSh.getLastRow() > 1) billersSh.getRange(2, col, billersSh.getLastRow() - 1, 1).setValue(false);
    }
    headers = billersSh.getRange(1, 1, 1, billersSh.getLastColumn()).getValues()[0];
    if (headers.indexOf('CanAccessStockEdit') === -1) {
      const col = billersSh.getLastColumn() + 1;
      billersSh.getRange(1, col).setValue('CanAccessStockEdit').setFontWeight('bold').setBackground('#E1341E').setFontColor('#FFFFFF');
      if (billersSh.getLastRow() > 1) billersSh.getRange(2, col, billersSh.getLastRow() - 1, 1).setValue(false);
    }
    // --- Billers: add CanAccessReportDownload column if missing - gates the
    //     Reports "Download Excel" button only (viewing every report on
    //     screen stays ungated for everyone, unchanged). ---
    headers = billersSh.getRange(1, 1, 1, billersSh.getLastColumn()).getValues()[0];
    if (headers.indexOf('CanAccessReportDownload') === -1) {
      const col = billersSh.getLastColumn() + 1;
      billersSh.getRange(1, col).setValue('CanAccessReportDownload').setFontWeight('bold').setBackground('#E1341E').setFontColor('#FFFFFF');
      if (billersSh.getLastRow() > 1) billersSh.getRange(2, col, billersSh.getLastRow() - 1, 1).setValue(false);
    }
  }

  // --- StockLog sheet (audit trail for every stock change) ---
  createSheetIfMissing_(ssRef, SHEET.STOCK_LOG, STOCK_LOG_HEADERS);

  // --- StockLog: add the 3 structured performer columns if missing, and
  //     backfill them from the old free-text "PerformedBy" column. This
  //     repairs historical data affected by a since-fixed bug where a
  //     biller's own sales were logged in a slightly different text format
  //     than everything else, so the old parser mis-read them - a Biller's
  //     sale showed "Name (ID)" dumped whole into the Name column with the
  //     ID column blank, and Super Admin actions showed their login
  //     username in the "Biller ID" column (which was never a biller ID at
  //     all). Going forward, every write populates these 3 columns
  //     directly - no more parsing text back apart. ---
  const stockLogSh = ssRef.getSheetByName(SHEET.STOCK_LOG);
  if (stockLogSh && stockLogSh.getLastColumn() > 0) {
    let headers = stockLogSh.getRange(1, 1, 1, stockLogSh.getLastColumn()).getValues()[0];
    ['PerformerRole', 'PerformerName', 'PerformerId'].forEach(colName => {
      headers = stockLogSh.getRange(1, 1, 1, stockLogSh.getLastColumn()).getValues()[0];
      if (headers.indexOf(colName) === -1) {
        const col = stockLogSh.getLastColumn() + 1;
        stockLogSh.getRange(1, col).setValue(colName).setFontWeight('bold').setBackground('#E1341E').setFontColor('#FFFFFF');
      }
    });
    if (stockLogSh.getLastRow() > 1) {
      const numRows = stockLogSh.getLastRow() - 1;
      const legacyLabels = stockLogSh.getRange(2, 8, numRows, 1).getValues(); // column H = PerformedBy
      const roleCol = stockLogSh.getRange(1, 1, 1, stockLogSh.getLastColumn()).getValues()[0].indexOf('PerformerRole') + 1;
      const existing = stockLogSh.getRange(2, roleCol, numRows, 3).getValues();
      const out = legacyLabels.map((row, idx) => {
        if (existing[idx][0]) return existing[idx]; // already backfilled - leave as-is
        const parsed = parseLegacyPerformedBy_(row[0]);
        return [parsed.role, parsed.name, parsed.id];
      });
      stockLogSh.getRange(2, roleCol, numRows, 3).setValues(out);
    }
  }

  // --- Customers: rename the "Name" header to "Customer Name" for clarity,
  //     and backfill any blank names using the Bills sheet, which has
  //     always recorded the customer's name correctly at billing time -
  //     this repairs historical data from a since-fixed bug where new
  //     customer records were being saved with a blank name. ---
  const custSh = ssRef.getSheetByName(SHEET.CUSTOMERS);
  if (custSh && custSh.getLastColumn() > 0) {
    const headerCell = custSh.getRange(1, 2);
    if (String(headerCell.getValue()).trim() === 'Name') headerCell.setValue('Customer Name');

    if (custSh.getLastRow() > 1) {
      const custData = custSh.getRange(2, 1, custSh.getLastRow() - 1, 2).getValues(); // [CustomerID, Name]
      const blankRows = [];
      custData.forEach((row, idx) => { if (row[0] && !String(row[1] || '').trim()) blankRows.push({ id: row[0], row: idx + 2 }); });
      if (blankRows.length) {
        const billsSh = ssRef.getSheetByName(SHEET.BILLS);
        const billsData = billsSh ? billsSh.getDataRange().getValues() : [];
        const nameById = {};
        for (let i = 1; i < billsData.length; i++) {
          const cid = billsData[i][2], nm = billsData[i][3];
          if (cid && nm && !nameById[cid]) nameById[cid] = nm;
        }
        blankRows.forEach(b => {
          if (nameById[b.id]) custSh.getRange(b.row, 2).setValue(nameById[b.id]);
        });
      }
    }
  }

  // --- Billers: add CanAccessDiscount + CanAccessDashboard columns if
  //     missing - same "off by default, admin opts a biller in" pattern as
  //     every other access flag above. ---
  if (billersSh && billersSh.getLastColumn() > 0) {
    ['CanAccessDiscount', 'CanAccessDashboard'].forEach(colName => {
      const headers = billersSh.getRange(1, 1, 1, billersSh.getLastColumn()).getValues()[0];
      if (headers.indexOf(colName) === -1) {
        const col = billersSh.getLastColumn() + 1;
        billersSh.getRange(1, col).setValue(colName).setFontWeight('bold').setBackground('#E1341E').setFontColor('#FFFFFF');
        if (billersSh.getLastRow() > 1) billersSh.getRange(2, col, billersSh.getLastRow() - 1, 1).setValue(false);
      }
    });
  }

  // --- Bills: add DiscountPercent column (the bill-level "additional
  //     discount", applied on top of any per-item discounts) if missing. ---
  const billsSh2 = ssRef.getSheetByName(SHEET.BILLS);
  if (billsSh2 && billsSh2.getLastColumn() > 0) {
    const headers = billsSh2.getRange(1, 1, 1, billsSh2.getLastColumn()).getValues()[0];
    if (headers.indexOf('DiscountPercent') === -1) {
      const col = billsSh2.getLastColumn() + 1;
      billsSh2.getRange(1, col).setValue('DiscountPercent').setFontWeight('bold').setBackground('#E1341E').setFontColor('#FFFFFF');
      if (billsSh2.getLastRow() > 1) billsSh2.getRange(2, col, billsSh2.getLastRow() - 1, 1).setValue(0);
    }
  }

  // --- BillItems: add DiscountPercent column (per-product discount) if
  //     missing. Existing rows get 0 (no discount) - their LineTotal was
  //     always the undiscounted qty×price anyway, so this is a true no-op
  //     for historical data. ---
  const itemsSh2 = ssRef.getSheetByName(SHEET.BILL_ITEMS);
  if (itemsSh2 && itemsSh2.getLastColumn() > 0) {
    const headers = itemsSh2.getRange(1, 1, 1, itemsSh2.getLastColumn()).getValues()[0];
    if (headers.indexOf('DiscountPercent') === -1) {
      const col = itemsSh2.getLastColumn() + 1;
      itemsSh2.getRange(1, col).setValue('DiscountPercent').setFontWeight('bold').setBackground('#E1341E').setFontColor('#FFFFFF');
      if (itemsSh2.getLastRow() > 1) itemsSh2.getRange(2, col, itemsSh2.getLastRow() - 1, 1).setValue(0);
    }
  }

  // --- Settings: add the ShowDiscountOption master switch if missing -
  //     same role for Discount as ShowTaxOnBill/ShowBankDetails already
  //     play for their own sections. ---
  const settingsSh0 = ssRef.getSheetByName(SHEET.SETTINGS);
  if (settingsSh0 && settingsSh0.getLastRow() > 0) {
    const keys = settingsSh0.getRange(1, 1, settingsSh0.getLastRow(), 1).getValues().map(r => r[0]);
    if (keys.indexOf('ShowDiscountOption') === -1) {
      settingsSh0.appendRow(['ShowDiscountOption', 'TRUE']);
    }
    // --- Theme customization defaults - only added if missing, so a shop
    //     that already customized these before this migration ran keeps
    //     their own colors instead of being reset. ---
    THEME_SETTING_DEFAULTS.forEach(pair => {
      if (keys.indexOf(pair[0]) === -1) settingsSh0.appendRow(pair);
    });
  }

  // --- CustomCharts: the sheet backing the Super Admin's "build your own
  //     dashboard chart" feature. Empty is normal - it only gets rows once
  //     someone actually creates a custom chart. ---
  createSheetIfMissing_(ssRef, SHEET.CUSTOM_CHARTS, CUSTOM_CHARTS_HEADERS);

  // --- UniversalReport: a live, human-readable "everything about every
  //     sale" mirror sheet, joining Bills + BillItems into one row per
  //     product line sold. Rebuilt automatically after every bill save/
  //     edit - see buildUniversalReportSheet_(). ---
  createSheetIfMissing_(ssRef, SHEET.UNIVERSAL_REPORT, UNIVERSAL_REPORT_HEADERS);
  createSheetIfMissing_(ssRef, SHEET.DAILY_REPORT, DAILY_REPORT_HEADERS);
  buildUniversalReportSheet_();
  buildDailyReportSheet_();

  props.setProperty('SchemaVersion', String(SCHEMA_VERSION));
}

// ---------------------------------------------------------------------------
// 1. ENTRY POINTS
// ---------------------------------------------------------------------------
function doGet(e) {
  try {
    migrateSchema_();
    const action = e.parameter.action;

    // Every GET action reads real business data (bills, customers, reports,
    // dashboard numbers...), so every one of them now requires a valid
    // session token issued at login. There is no public/no-login GET action.
    const authCheck = requireSession_(e.parameter.token);
    if (!authCheck.ok) return jsonOut(authCheck);

    let result;
    switch (action) {
      case 'bootstrap':      result = apiBootstrap(); break;
      case 'findCustomer':   result = apiFindCustomer(e.parameter.phone, e.parameter.name); break;
      case 'getCustomers':   result = apiGetCustomersList(); break;
      case 'getBillStatus':  result = apiGetBillStatus(e.parameter.billId); break;
      case 'getBill':        result = apiGetBill(e.parameter.billId); break;
      case 'getDashboardData': result = apiGetDashboardData(e.parameter); break;
      case 'getBillers':     result = apiGetBillers(); break;
      case 'getProducts':    result = apiGetProducts(true); break;
      case 'getSettings':    result = apiGetSettingsPublic(); break;
      case 'getStockLog':    result = apiGetStockLog(e.parameter); break;
      case 'getCapacityStatus': result = apiGetCapacityStatus(); break;
      case 'getUniversalReport':    result = apiGetUniversalReport(); break;
      case 'getDailyReport':        result = apiGetDailyReport(); break;
      case 'getInventoryLogReport': result = apiGetInventoryLogReport(); break;
      case 'getCustomCharts': result = apiGetCustomCharts(); break;
      case 'getCustomChartData': result = apiGetCustomChartData(e.parameter); break;
      default:
        result = { ok: false, error: 'Unknown GET action: ' + action };
    }
    return jsonOut(result);
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    migrateSchema_();
    // ---- Branch 1: Razorpay webhook (identified via a secret URL token) ----
    const settings = getSettingsMap_();
    const webhookToken = settings['WebhookToken'] || '';
    if (e.parameter.token && webhookToken && e.parameter.token === webhookToken) {
      return handleRazorpayWebhook_(e, settings);
    }

    // ---- Branch 2: normal app API call ----
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    const p = body.payload || {};

    // Every POST action except 'login' itself now requires a valid session
    // token (see requireSession_ / createSession_ above). 'login' is how a
    // token is obtained in the first place, so it's the one exception.
    if (action !== 'login') {
      const authCheck = requireSession_(body.token);
      if (!authCheck.ok) return jsonOut(authCheck);
    }

    let result;
    switch (action) {
      case 'login':          result = apiLogin(p); break;
      case 'verifyBiller':   result = apiVerifyBiller(p); break;
      case 'saveBill':       result = apiSaveBill(p); break;
      case 'refreshDashboardSheet': result = apiRefreshDashboardSheet(p); break;
      case 'updateBill':     result = apiUpdateBill(p); break;
      case 'saveCustomer':   result = apiSaveCustomer(p); break;
      case 'addProduct':     result = apiAddProduct(p); break;
      case 'updateProduct':  result = apiUpdateProduct(p); break;
      case 'deleteProduct':  result = apiDeleteProduct(p); break;
      case 'saveBiller':     result = apiSaveBiller(p); break;
      case 'toggleBiller':   result = apiToggleBiller(p); break;
      case 'setBillerAccess': result = apiSetBillerAccess(p); break;
      case 'deleteBiller':   result = apiDeleteBiller(p); break;
      case 'setProductStock': result = apiSetProductStock(p); break;
      case 'updateSettings': result = apiUpdateSettings(p); break;
      case 'checkQrStatusNow': result = apiCheckQrStatusNow(p); break;
      case 'emailBillPdf':   result = apiEmailBillPdf(p); break;
      case 'autoExpandDatabase': result = apiAutoExpandDatabase(p); break;
      case 'getDataDiagnostics': result = apiGetDataDiagnostics(p); break;
      case 'resetToActiveOnly': result = apiResetToActiveOnly(p); break;
      case 'updateTheme': result = apiUpdateTheme(p); break;
      case 'resetTheme': result = apiResetTheme(p); break;
      case 'getCustomCharts': result = apiGetCustomCharts(); break;
      case 'saveCustomChart': result = apiSaveCustomChart(p); break;
      case 'deleteCustomChart': result = apiDeleteCustomChart(p); break;
      case 'reorderCustomCharts': result = apiReorderCustomCharts(p); break;
      case 'getCustomChartData': result = apiGetCustomChartData(p); break;
      default:
        result = { ok: false, error: 'Unknown POST action: ' + action };
    }
    return jsonOut(result);
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// 1b. SESSION AUTH - added because the deployment is "Execute as: Me" +
//     "Anyone", which means Google's own login is intentionally OFF and
//     this app's code is the ONLY gate. Before this, doGet actions had no
//     check at all - anyone with the /exec URL could call ?action=getBill
//     etc. directly with no login. Now every action (GET and POST, except
//     'login' itself and the Razorpay webhook) requires a valid session
//     token, minted only by a successful apiLogin() and stored server-side
//     in CacheService (max 6h, matches Apps Script's own cache ceiling).
// ---------------------------------------------------------------------------
const SESSION_TTL_SECONDS = 21600; // 6 hours - CacheService's own maximum

function createSession_(sessionData) {
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(sessionData), SESSION_TTL_SECONDS);
  return token;
}

function requireSession_(token) {
  if (!token) return { ok: false, error: 'Not logged in. Please log in again.', sessionExpired: true };
  const raw = CacheService.getScriptCache().get('sess_' + token);
  if (!raw) return { ok: false, error: 'Your session has expired. Please log in again.', sessionExpired: true };
  return { ok: true, session: JSON.parse(raw) };
}

// ---------------------------------------------------------------------------
// 2. SETTINGS HELPERS
// ---------------------------------------------------------------------------
function getSettingsMap_() {
  const sh = ss_().getSheetByName(SHEET.SETTINGS);
  const data = sh.getDataRange().getValues();
  const map = {};
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) map[data[i][0]] = data[i][1];
  }
  return map;
}

function setSetting_(key, value) {
  const sh = ss_().getSheetByName(SHEET.SETTINGS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      sh.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sh.appendRow([key, value]);
}

function ss_() {
  // If ACTIVE_SPREADSHEET_ID has been set (see archiveCurrentSpreadsheetAndSwitch_
  // below), every read/write goes to THAT spreadsheet by ID instead of the
  // one this script happens to be bound to. Until you ever run that
  // function, this property is unset and behavior is 100% identical to
  // before - this is a zero-risk addition for today.
  const activeId = PropertiesService.getScriptProperties().getProperty('ACTIVE_SPREADSHEET_ID');
  if (activeId) {
    try {
      return SpreadsheetApp.openById(activeId);
    } catch (e) {
      throw new Error('ACTIVE_SPREADSHEET_ID is set to "' + activeId + '" but that spreadsheet could not be opened (' + e + '). Check the ID is correct and this script\'s account still has access to it.');
    }
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

// ---------------------------------------------------------------------------
// 0d. MULTI-SPREADSHEET CONTINUITY - the "Active + Archive" model.
//
// When a spreadsheet gets close to Google's cell ceiling (see the Reports &
// Row Limits note in Admin Settings), the fix is to run
// archiveCurrentSpreadsheetAndSwitch_() ONCE, manually, from this editor -
// exactly the way you ran setupDatabase(). That single call:
//   1. Freezes the CURRENT spreadsheet as a read-only "archive" - the app
//      can still find and display its invoices and stock history, just
//      can't edit them.
//   2. Points every future write (new bills, new customers, stock changes,
//      etc.) at a brand-new spreadsheet.
// Nothing about the deployment URL, the frontend, or a biller's login
// changes - it's invisible to anyone using the app. See the runbook
// wherever this was explained to you for the full step-by-step.
//
// MASTER DATA (Settings, Billers, Products, Customers) is only ever read
// from the ACTIVE spreadsheet - carry it forward when you switch (either
// via File > Make a copy, or by re-entering it) so staff logins, the
// product catalog, and the customer list never "reset."
//
// TRANSACTIONAL DATA (Bills, BillItems, PaymentLogs, StockLog) is what
// actually grows large over time - this is the data that gets archived and
// starts fresh in the new active spreadsheet, and Reports/Find-Bill
// transparently read across both.
// ---------------------------------------------------------------------------
function getArchiveRegistry_() {
  const raw = PropertiesService.getScriptProperties().getProperty('ARCHIVE_SPREADSHEET_IDS');
  if (!raw) return [];
  try { return JSON.parse(raw) || []; } catch (e) { return []; }
}

// Opens every registered archive. An archive that's been deleted, unshared,
// or is briefly unreachable is skipped (logged, not thrown) so one bad
// archive can never take down Reports or Find Bill for everyone else.
function openArchives_() {
  return getArchiveRegistry_().map(entry => {
    try {
      return { ss: SpreadsheetApp.openById(entry.id), label: entry.label || entry.id };
    } catch (e) {
      Logger.log('Archive spreadsheet unreachable, skipped: ' + entry.id + ' - ' + e);
      return null;
    }
  }).filter(Boolean);
}

// Every database this app can currently read from - the active one first,
// so "most recent" data naturally sorts first wherever this is used.
function allDbs_() {
  return [{ ss: ss_(), label: 'Active' }].concat(openArchives_());
}

// ---- The one-time switch, run manually from the Apps Script editor ----
// newSpreadsheetId: the ID of a spreadsheet that already has the SJP tab
// structure (run setupDatabase() on a blank new spreadsheet first, or use
// File > Make a copy of the current one - see the runbook for exactly
// which sheets to clear afterward vs. carry forward).
function archiveCurrentSpreadsheetAndSwitch_(newSpreadsheetId, archiveLabel) {
  const props = PropertiesService.getScriptProperties();
  const currentActiveId = props.getProperty('ACTIVE_SPREADSHEET_ID') || SpreadsheetApp.getActiveSpreadsheet().getId();

  const registry = getArchiveRegistry_();
  const label = archiveLabel || ('Archived ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Etc/UTC', 'yyyy-MM-dd'));
  registry.push({ id: currentActiveId, label: label, archivedAt: new Date().toISOString() });
  props.setProperty('ARCHIVE_SPREADSHEET_IDS', JSON.stringify(registry));
  props.setProperty('ACTIVE_SPREADSHEET_ID', newSpreadsheetId);

  SpreadsheetApp.getUi().alert(
    'Switched!\n\n' +
    'The old spreadsheet is now archived as "' + label + '" - the app will still find and display its invoices ' +
    'and stock history, but can no longer edit them.\n\n' +
    'All new bills, customers, products, and stock changes now go to the new spreadsheet.\n\n' +
    'Nothing else needs to change - the same web app URL keeps working for every biller and Super Admin, ' +
    'with no re-login or re-setup needed.'
  );
}

// Undo, in case a switch was made by mistake - run manually, same way.
function undoLastArchiveSwitch_() {
  const props = PropertiesService.getScriptProperties();
  const registry = getArchiveRegistry_();
  if (!registry.length) { SpreadsheetApp.getUi().alert('There is no archive switch to undo.'); return; }
  const last = registry.pop();
  props.setProperty('ARCHIVE_SPREADSHEET_IDS', JSON.stringify(registry));
  props.setProperty('ACTIVE_SPREADSHEET_ID', last.id);
  SpreadsheetApp.getUi().alert('Reverted - the active spreadsheet is back to "' + last.label + '".');
}

// =============================================================================
// ⭐ "FILL IN THE BLANK, THEN CLICK RUN" - no coding needed.
//
// These two functions exist so you never have to write or understand any
// actual code - you only ever replace the text between the quote marks
// below, then click the Run button, exactly like filling in a form. Full
// click-by-click instructions (with exactly which menus to open) are in
// the "Data Continuity & Row Limits" panel on the website, under
// Admin Settings → Products.
// =============================================================================

// ---- STEP: Replace the two lines below, click Save, then click Run ----
function RUN_ME_TO_ARCHIVE_AND_SWITCH() {
  const NEW_SPREADSHEET_ID = 'PASTE_YOUR_NEW_SPREADSHEET_ID_HERE';
  const ARCHIVE_LABEL      = 'PASTE_A_SHORT_LABEL_HERE'; // e.g. '2027' or 'Year 2'

  if (NEW_SPREADSHEET_ID === 'PASTE_YOUR_NEW_SPREADSHEET_ID_HERE') {
    SpreadsheetApp.getUi().alert(
      'Stop - you still need to fill in the blanks first.\n\n' +
      'Open this function (look for RUN_ME_TO_ARCHIVE_AND_SWITCH near the ' +
      'bottom of the code), replace PASTE_YOUR_NEW_SPREADSHEET_ID_HERE with ' +
      'your new spreadsheet\'s ID (keep the quote marks around it), click ' +
      'Save, then click Run again.'
    );
    return;
  }
  archiveCurrentSpreadsheetAndSwitch_(NEW_SPREADSHEET_ID, ARCHIVE_LABEL);
}

// ---- Only run this if the switch above was a mistake and needs undoing ----
function RUN_ME_TO_UNDO_LAST_SWITCH() {
  undoLastArchiveSwitch_();
}

// ---------------------------------------------------------------------------
// 0e2. ONE-CLICK AUTOMATIC DATABASE EXPANSION - everything RUN_ME_TO_ARCHIVE_
//     AND_SWITCH does above, but triggered from a single button on the
//     website (Admin Settings → Data Continuity) instead of opening this
//     Apps Script editor at all. No spreadsheet ID to copy, no placeholder
//     text to fill in, no Run button to click by hand.
//
//     What it does, in order, in one go:
//       1. Creates a brand-new Google Spreadsheet (via SpreadsheetApp.create,
//          which is free - it's just a normal Sheet in the same Google
//          account that owns this script, same as clicking "Blank
//          spreadsheet" in Drive).
//       2. Lays out all the same tabs/headers this app expects on it
//          (provisionSchemaOnSpreadsheet_ - the exact same function used
//          the very first time this app was set up).
//       3. Copies Settings, Billers, Products and Customers across so
//          staff logins, the product list, stock counts and the customer
//          list carry forward with nothing to redo - Bills/BillItems/
//          PaymentLogs/StockLog are deliberately left empty on the new
//          sheet, since those are exactly what "starting fresh" means.
//       4. Registers the OLD spreadsheet as a read-only archive and points
//          every future write at the new one - identical bookkeeping to
//          archiveCurrentSpreadsheetAndSwitch_ above, just called from
//          code instead of by hand.
//     Nothing about the deployment URL, the frontend, or anyone's login
//     changes - it's invisible to billers using the app.
// ---------------------------------------------------------------------------

// Creates a brand-new, empty-but-fully-structured spreadsheet and returns
// it. Also removes the default "Sheet1" tab Google adds automatically,
// since this app never uses a sheet by that name.
function createFreshDatabaseSpreadsheet_(name) {
  const newSs = SpreadsheetApp.create(name);
  provisionSchemaOnSpreadsheet_(newSs);
  const defaultSheet = newSs.getSheetByName('Sheet1');
  if (defaultSheet && newSs.getSheets().length > 1) {
    newSs.deleteSheet(defaultSheet);
  }
  return newSs;
}

// Copies MASTER data forward from one spreadsheet to another - Settings,
// Billers, Products, Customers. Never touches Bills/BillItems/PaymentLogs/
// StockLog (that transactional history is exactly what stays behind on the
// archived spreadsheet). Safe to call on a freshly-provisioned target sheet
// (headers only, one row) - it simply fills in the rows underneath.
function copyMasterDataForward_(fromSs, toSs) {
  [SHEET.SETTINGS, SHEET.BILLERS, SHEET.PRODUCTS, SHEET.CUSTOMERS].forEach(function (name) {
    const fromSh = fromSs.getSheetByName(name);
    const toSh = toSs.getSheetByName(name);
    if (!fromSh || !toSh) return;
    const data = fromSh.getDataRange().getValues();
    if (data.length <= 1) return; // header only - nothing to carry over
    const rows = data.slice(1);
    const numCols = data[0].length;
    if (toSh.getLastRow() > 1) {
      toSh.getRange(2, 1, toSh.getLastRow() - 1, toSh.getLastColumn()).clearContent();
    }
    toSh.getRange(2, 1, rows.length, numCols).setValues(rows);
  });
}

// The API endpoint the "Add New Database" button on the website calls.
// Requires Super Admin credentials, same as every other admin action.
function apiAutoExpandDatabase(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const oldSs = ss_();
    const oldId = oldSs.getId();
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Etc/UTC', 'yyyy-MM-dd HH:mm');
    const label = (p.label && String(p.label).trim())
      ? String(p.label).trim()
      : ('Archived ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Etc/UTC', 'yyyy-MM-dd'));
    const companyName = getSettingsMap_().CompanyName || 'Billing';
    const newName = companyName + ' - Billing DB (' + timestamp + ')';

    const newSs = createFreshDatabaseSpreadsheet_(newName);
    copyMasterDataForward_(oldSs, newSs);

    const props = PropertiesService.getScriptProperties();
    const registry = getArchiveRegistry_();
    registry.push({ id: oldId, label: label, archivedAt: new Date().toISOString() });
    props.setProperty('ARCHIVE_SPREADSHEET_IDS', JSON.stringify(registry));
    props.setProperty('ACTIVE_SPREADSHEET_ID', newSs.getId());
    // The new spreadsheet was just provisioned with today's schema, so it's
    // already fully caught up - keeps migrateSchema_() from doing any
    // redundant work on the very next request.
    props.setProperty('SchemaVersion', String(SCHEMA_VERSION));

    return {
      ok: true,
      archivedLabel: label,
      newSpreadsheetName: newName,
      newSpreadsheetUrl: newSs.getUrl(),
      newSpreadsheetId: newSs.getId()
    };
  } catch (err) {
    return { ok: false, error: 'Could not create the new database automatically: ' + err };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// 0f. DATA DIAGNOSTICS & RESET TOOLS
//
// Invoice/Customer/Product numbers are deliberately generated from a counter
// stored in THIS SCRIPT's own properties (see the big note above
// nextSequentialId_) rather than by counting rows in the spreadsheet - that
// is what lets numbering survive an "Add New Database" switch without
// restarting. The trade-off: if someone edits the spreadsheet directly
// (clears rows by hand, tests File > Make a copy, tries the archive/switch
// feature and changes their mind, etc.) that counter has no way to know and
// keeps counting from where it left off - which looks exactly like "the
// numbers aren't live" even though nothing is actually broken.
//
// These two functions are the deliberate, explicit fix for that: a read-only
// diagnostic that shows exactly what this script currently thinks is true
// (which spreadsheet is active, what's linked as an archive, what the next
// few IDs will be), and a one-click, clearly-labeled reset that re-bases
// everything on ONLY the active spreadsheet's actual current rows and
// forgets any linked archives. Nothing here ever deletes or edits a single
// row of spreadsheet data - it only resets this script's own bookkeeping.
// ---------------------------------------------------------------------------
function apiGetDataDiagnostics(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;

  const activeSs = ss_();
  const archives = getArchiveRegistry_().map(entry => {
    try {
      const archiveSs = SpreadsheetApp.openById(entry.id);
      return { id: entry.id, label: entry.label || entry.id, name: archiveSs.getName(), url: archiveSs.getUrl(), reachable: true };
    } catch (e) {
      return { id: entry.id, label: entry.label || entry.id, name: '(not reachable - deleted or unshared)', url: '', reachable: false };
    }
  });

  const billsSh = activeSs.getSheetByName(SHEET.BILLS);
  const custSh = activeSs.getSheetByName(SHEET.CUSTOMERS);
  const prodSh = activeSs.getSheetByName(SHEET.PRODUCTS);

  return {
    ok: true,
    activeSpreadsheetName: activeSs.getName(),
    activeSpreadsheetId: activeSs.getId(),
    activeSpreadsheetUrl: activeSs.getUrl(),
    archives: archives,
    activeRowCounts: {
      bills: Math.max(0, (billsSh ? billsSh.getLastRow() : 1) - 1),
      customers: Math.max(0, (custSh ? custSh.getLastRow() : 1) - 1),
      products: Math.max(0, (prodSh ? prodSh.getLastRow() : 1) - 1)
    },
    nextBillId: peekNextBillId_(),
    nextCustomerId: nextSequentialId_('IDCTR_CUST', 'CUST', 4, custSh, 0, false),
    nextProductId: nextSequentialId_('IDCTR_PROD', 'PROD', 4, prodSh, 0, false)
  };
}

// The confirmed, deliberate reset. Un-links any archive spreadsheets (they
// are NOT touched or deleted - just forgotten, so Reports/Find Bill/ID
// numbering stop pulling from them) and re-bases every ID counter on ONLY
// what's actually sitting in the active spreadsheet's rows right now.
function apiResetToActiveOnly(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    const activeSs = ss_();

    props.deleteProperty('ARCHIVE_SPREADSHEET_IDS');

    const billsSh = activeSs.getSheetByName(SHEET.BILLS);
    const custSh = activeSs.getSheetByName(SHEET.CUSTOMERS);
    const prodSh = activeSs.getSheetByName(SHEET.PRODUCTS);

    const billMax = highestExistingIdSuffix_(billsSh, 0);
    const custMax = highestExistingIdSuffix_(custSh, 0);
    const prodMax = highestExistingIdSuffix_(prodSh, 0);

    props.setProperty('IDCTR_SJP', String(billMax));
    props.setProperty('IDCTR_CUST', String(custMax));
    props.setProperty('IDCTR_PROD', String(prodMax));

    return {
      ok: true,
      nextBillId: 'SJP-' + Utilities.formatString('%06d', billMax + 1),
      nextCustomerId: 'CUST-' + Utilities.formatString('%04d', custMax + 1),
      nextProductId: 'PROD-' + Utilities.formatString('%04d', prodMax + 1)
    };
  } catch (err) {
    return { ok: false, error: 'Could not reset: ' + err };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// 0e. CAPACITY MONITORING - this is what actually answers "how will I know
//     when it's time to archive?" without anyone having to remember to
//     check. Google's per-spreadsheet ceiling is ~1 crore (10,000,000)
//     cells, counting every allocated row × column on every tab, not just
//     cells with data in them. Super Admin sees a live percentage in Admin
//     Settings every time that screen opens, and gets an on-screen warning
//     banner automatically once usage crosses the threshold below - no
//     email setup, no separate monitoring tool, nothing to configure.
// ---------------------------------------------------------------------------
const CAPACITY_CELL_LIMIT = 10000000;
const CAPACITY_WARNING_THRESHOLD = 0.75; // start warning at 75% full, well before the ceiling
// Hard-stop threshold - once the ACTIVE spreadsheet crosses this, the
// website itself refuses to save any new bill (both the popup on the
// Create Bill screen AND a server-side check inside apiSaveBill below),
// rather than letting it silently fail once Google's real ceiling is hit.
// Left with a small buffer under 100% on purpose.
const CAPACITY_BLOCK_THRESHOLD = 0.98;

function apiGetCapacityStatus() {
  const ssRef = ss_();
  let totalCells = 0;
  ssRef.getSheets().forEach(sh => {
    totalCells += sh.getMaxRows() * sh.getMaxColumns();
  });
  const pct = totalCells / CAPACITY_CELL_LIMIT;
  return {
    ok: true,
    totalCells: totalCells,
    limit: CAPACITY_CELL_LIMIT,
    percentUsed: Math.round(pct * 1000) / 10, // one decimal place
    warning: pct >= CAPACITY_WARNING_THRESHOLD,
    blocked: pct >= CAPACITY_BLOCK_THRESHOLD
  };
}

function apiGetSettingsPublic() {
  const s = getSettingsMap_();
  const on = (v) => {
    if (v === true || v === 1) return true;
    if (v === false || v === 0) return false;
    const t = String(v == null ? '' : v).trim().toUpperCase();
    if (t === 'FALSE' || t === '0' || t === 'NO' || t === '') return false;
    return true;
  };
  // Every Theme* field (colors, styles, fonts, layout) is served from
  // THEME_SETTING_DEFAULTS - one place lists every themeable key and its
  // default, so adding a new theme option never means touching this
  // function again. Falls back to the default the instant a shop's
  // Settings sheet is missing a key (e.g. right after this feature grew a
  // new field) - same "never breaks an existing shop" guarantee the rest
  // of this app already relies on.
  const themeFieldsOut = {};
  THEME_SETTING_DEFAULTS.forEach(function (pair) {
    themeFieldsOut[pair[0]] = (s[pair[0]] !== undefined && s[pair[0]] !== '') ? s[pair[0]] : pair[1];
  });

  return {
    ok: true,
    settings: Object.assign({
      CompanyName: s.CompanyName || '',
      Address: s.Address || '',
      Phone: s.Phone || '',
      Website: s.Website || '',
      GSTNumber: s.GSTNumber || '',
      LogoURL: s.LogoURL || '',
      PrintLogoURL: s.PrintLogoURL || '',
      Currency: s.Currency || 'INR',
      CompanyEmail: s.CompanyEmail || '',
      CGSTPercent: Number(s.CGSTPercent) || 0,
      SGSTPercent: Number(s.SGSTPercent) || 0,
      BankName: s.BankName || '',
      BankAccountNo: s.BankAccountNo || '',
      BankIFSC: s.BankIFSC || '',
      BankAccountHolder: s.BankAccountHolder || '',
      AuthorizedSignatoryLabel: s.AuthorizedSignatoryLabel || 'Authorized Signatory',
      ShowCompanyEmail: (s.ShowCompanyEmail === undefined || s.ShowCompanyEmail === '') ? true : on(s.ShowCompanyEmail),
      ShowTaxOnBill: (s.ShowTaxOnBill === undefined || s.ShowTaxOnBill === '') ? true : on(s.ShowTaxOnBill),
      ShowBankDetails: (s.ShowBankDetails === undefined || s.ShowBankDetails === '') ? true : on(s.ShowBankDetails),
      ShowDiscountOption: (s.ShowDiscountOption === undefined || s.ShowDiscountOption === '') ? true : on(s.ShowDiscountOption),
      ShowAuthorizedSignatory: (s.ShowAuthorizedSignatory === undefined || s.ShowAuthorizedSignatory === '') ? true : on(s.ShowAuthorizedSignatory)
    }, themeFieldsOut)
  };
}

function apiUpdateSettings(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  // Allow empty string so fields like PrintLogoURL can be cleared intentionally.
  const fields = [
    'CompanyName', 'Address', 'Phone', 'Website', 'GSTNumber',
    'LogoURL', 'PrintLogoURL',
    'RazorpayKeyId', 'RazorpayKeySecret',
    'CompanyEmail', 'CGSTPercent', 'SGSTPercent',
    'BankName', 'BankAccountNo', 'BankIFSC', 'BankAccountHolder',
    'AuthorizedSignatoryLabel',
    'ShowCompanyEmail', 'ShowTaxOnBill', 'ShowBankDetails', 'ShowDiscountOption', 'ShowAuthorizedSignatory'
  ];
  fields.forEach(f => {
    if (p[f] !== undefined && p[f] !== null) setSetting_(f, p[f]);
  });
  if (p.newSuperAdminUser) setSetting_('SuperAdminUser', p.newSuperAdminUser);
  if (p.newSuperAdminPass) setSetting_('SuperAdminPass', p.newSuperAdminPass);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 2b. THEME CUSTOMIZATION - Super Admin only. Colors are stored as plain
//     Settings rows (see THEME_SETTING_DEFAULTS) and picked up by the
//     frontend on every load, which pushes them into CSS custom properties
//     so the whole site re-themes live - no code change, no redeploy needed
//     for a color change, ever.
// ---------------------------------------------------------------------------
function apiUpdateTheme(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  // Every themeable key is listed once, in THEME_SETTING_DEFAULTS - reusing
  // that list here (instead of a second hand-maintained array) means a new
  // theme option added there is automatically accepted by Save, with
  // nothing else to remember to update.
  THEME_SETTING_DEFAULTS.forEach(function (pair) {
    const f = pair[0];
    if (p[f] !== undefined && p[f] !== null && p[f] !== '') setSetting_(f, p[f]);
  });
  return { ok: true };
}

function apiResetTheme(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  THEME_SETTING_DEFAULTS.forEach(pair => setSetting_(pair[0], pair[1]));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 3. AUTH
// ---------------------------------------------------------------------------
function apiLogin(p) {
  const s = getSettingsMap_();
  const user = (s.SuperAdminUser || 'SJ Physiotherapy').trim();
  const pass = String(s.SuperAdminPass || 'SJ12345').trim();
  const uname = (p.username || '').trim();
  const pwd = (p.password || '').trim();

  if (uname === user && pwd === pass) {
    const token = createSession_({ role: 'admin', displayName: user });
    return { ok: true, role: 'admin', displayName: user, sessionToken: token };
  }

  // Not the super admin - try matching a biller's own login (BillerID + their password).
  const sh = ss_().getSheetByName(SHEET.BILLERS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const [id, name, bpass, active, , canTax, canBank, canFindEdit, canStockView, canStockEdit, canReportDownload, canDiscount, canDashboard] = data[i];
    if (!id) continue;
    if (String(id) === uname && String(bpass) === pwd) {
      const isActive = active === true || String(active).toUpperCase() === 'TRUE';
      if (!isActive) return { ok: false, error: 'This biller ID is deactivated' };
      const token = createSession_({ role: 'biller', billerId: id, billerName: name });
      return {
        ok: true, role: 'biller', displayName: name,
        billerId: id, billerName: name, sessionToken: token,
        canAccessTax: canTax === true || String(canTax).toUpperCase() === 'TRUE',
        canAccessBank: canBank === true || String(canBank).toUpperCase() === 'TRUE',
        canAccessFindEdit: canFindEdit === true || String(canFindEdit).toUpperCase() === 'TRUE',
        canAccessStockView: canStockView === true || String(canStockView).toUpperCase() === 'TRUE',
        canAccessStockEdit: canStockEdit === true || String(canStockEdit).toUpperCase() === 'TRUE',
        canAccessReportDownload: canReportDownload === true || String(canReportDownload).toUpperCase() === 'TRUE',
        canAccessDiscount: canDiscount === true || String(canDiscount).toUpperCase() === 'TRUE',
        canAccessDashboard: canDashboard === true || String(canDashboard).toUpperCase() === 'TRUE'
      };
    }
  }
  return { ok: false, error: 'Invalid username or password' };
}

function requireSuperAdmin_(user, pass) {
  const s = getSettingsMap_();
  const su = (s.SuperAdminUser || 'SJ Physiotherapy').trim();
  const sp = String(s.SuperAdminPass || 'SJ12345').trim();
  if ((user || '').trim() === su && (pass || '').trim() === sp) return { ok: true };
  return { ok: false, error: 'Super admin credentials required or incorrect' };
}

function apiVerifyBiller(p) {
  const sh = ss_().getSheetByName(SHEET.BILLERS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const [billerId, name, pass, active, , canTax, canBank, , , , , canDiscount] = data[i];
    if (String(billerId) === String(p.billerId) && String(pass) === String(p.password)) {
      if (active !== true && String(active).toUpperCase() !== 'TRUE') {
        return { ok: false, error: 'This biller ID is deactivated' };
      }
      return {
        ok: true, billerId: billerId, billerName: name,
        // Live from the Billers sheet at save time - NOT whatever the
        // client sent. This is what apiSaveBill uses to enforce
        // tax/bank/discount visibility server-side, so a stale client
        // session (or a tampered request) can never leak tax/bank/discount
        // for a biller whose access has since been revoked.
        canAccessTax: canTax === true || String(canTax).toUpperCase() === 'TRUE',
        canAccessBank: canBank === true || String(canBank).toUpperCase() === 'TRUE',
        canAccessDiscount: canDiscount === true || String(canDiscount).toUpperCase() === 'TRUE'
      };
    }
  }
  return { ok: false, error: 'Invalid biller ID or password' };
}

// ---------------------------------------------------------------------------
// 4. BOOTSTRAP (everything the billing screen needs on load)
// ---------------------------------------------------------------------------
function apiBootstrap() {
  return {
    ok: true,
    settings: apiGetSettingsPublic().settings,
    products: apiGetProducts(false).products,
    billers: apiGetBillers().billers.filter(b => b.active),
    customers: apiGetCustomersList().customers,
    nextBillId: peekNextBillId_(),
    serverBuild: BACKEND_BUILD
  };
}

// Lightweight list of all customers (id + name + phone) - used to power the
// "search by Customer ID" dropdown on the Dashboard filter bar.
function apiGetCustomersList() {
  const sh = ss_().getSheetByName(SHEET.CUSTOMERS);
  const data = sh.getDataRange().getValues();
  const customers = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;
    customers.push({ id: row[0], name: row[1], phone: row[2] });
  }
  return { ok: true, customers: customers };
}

// ---------------------------------------------------------------------------
// 5. CUSTOMERS
// ---------------------------------------------------------------------------
function apiFindCustomer(phone, name) {
  const sh = ss_().getSheetByName(SHEET.CUSTOMERS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rowPhone = String(row[2] || '').trim();
    const rowName = String(row[1] || '').trim().toLowerCase();
    if (phone && rowPhone && rowPhone === String(phone).trim()) {
      return { ok: true, found: true, customer: rowToCustomer_(row) };
    }
    if (!phone && name && rowName === String(name).trim().toLowerCase()) {
      return { ok: true, found: true, customer: rowToCustomer_(row) };
    }
  }
  return { ok: true, found: false };
}

function rowToCustomer_(row) {
  return {
    customerId: row[0], name: row[1], phone: row[2], email: row[3],
    address: row[4], deliveryAddress: row[5]
  };
}

// skipLock=true when the caller (apiSaveBill) already holds the script
// lock for its whole transaction - see the note on nextSequentialId_.
function apiSaveCustomer(p, skipLock) {
  const doWork = () => {
    const sh = ss_().getSheetByName(SHEET.CUSTOMERS);
    const id = nextId_(sh, 'CUST');
    // NOTE: the bill-save payload's field is "customerName" (matching the
    // Bills sheet), not "name" - this used to read p.name here, which is
    // always undefined, so every new customer was saved with a blank name.
    sh.appendRow([id, p.customerName || '', p.phone || '', p.email || '', p.address || '',
                  p.deliveryAddress || '', new Date()]);
    return { ok: true, customerId: id };
  };
  if (skipLock) return doWork();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return doWork(); } finally { lock.releaseLock(); }
}

function updateCustomerIfChanged_(customerId, p) {
  const sh = ss_().getSheetByName(SHEET.CUSTOMERS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(customerId)) {
      // Only overwrite a field when a new value was actually provided -
      // this also opportunistically repairs a blank Name left over from
      // the bug above, without ever erasing a name that's already there.
      sh.getRange(i + 1, 2).setValue(p.customerName || data[i][1]);
      sh.getRange(i + 1, 4).setValue(p.email || data[i][3]);
      sh.getRange(i + 1, 5).setValue(p.address || data[i][4]);
      sh.getRange(i + 1, 6).setValue(p.deliveryAddress || data[i][5]);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// 6. PRODUCTS
// ---------------------------------------------------------------------------
function apiGetProducts(includeInactive) {
  const sh = ss_().getSheetByName(SHEET.PRODUCTS);
  const data = sh.getDataRange().getValues();
  const products = [];
  for (let i = 1; i < data.length; i++) {
    const [id, name, price, active, , stockRaw, thresholdRaw] = data[i];
    if (!name) continue;
    const isActive = active === true || String(active).toUpperCase() === 'TRUE';
    if (includeInactive || isActive) {
      // stock === null means "not tracked" - the product was never given a
      // starting stock value, so we never show a badge that implies we know
      // the count. Once someone sets a stock value (via the Inventory menu
      // or the Products admin tab), it becomes a normal tracked number,
      // including zero.
      const tracked = stockRaw !== '' && stockRaw !== null && stockRaw !== undefined;
      products.push({
        id: id, name: name, defaultPrice: price, active: isActive,
        stock: tracked ? Number(stockRaw) : null,
        lowStockThreshold: (thresholdRaw !== '' && thresholdRaw !== null && thresholdRaw !== undefined) ? Number(thresholdRaw) : 5
      });
    }
  }
  return { ok: true, products: products };
}

function apiAddProduct(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = ss_().getSheetByName(SHEET.PRODUCTS);
    const id = nextId_(sh, 'PROD');
    const hasStock = p.stock !== undefined && p.stock !== null && p.stock !== '';
    const stockVal = hasStock ? Number(p.stock) : '';
    const thresholdVal = (p.lowStockThreshold !== undefined && p.lowStockThreshold !== null && p.lowStockThreshold !== '')
      ? Number(p.lowStockThreshold) : 5;
    sh.appendRow([id, p.name, p.defaultPrice || 0, true, new Date(), stockVal, thresholdVal]);
    if (hasStock) logStockChange_(id, p.name, 'Initial Stock', stockVal, stockVal, '', 'System', 'System (new product)', '');
    return { ok: true, productId: id };
  } finally {
    lock.releaseLock();
  }
}


function apiUpdateProduct(p) {
  // Admin-panel edits are gated behind Super Admin credentials, same as
  // Billers and Shop Details. (The separate "quick add while billing"
  // flow uses apiAddProduct directly and is intentionally left open to
  // any signed-in biller - see apiAddProduct below.)
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const sh = ss_().getSheetByName(SHEET.PRODUCTS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.productId)) {
      sh.getRange(i + 1, 2).setValue(p.name);
      sh.getRange(i + 1, 3).setValue(p.defaultPrice || 0);
      sh.getRange(i + 1, 4).setValue(p.active !== false);
      if (p.stock !== undefined && p.stock !== null && p.stock !== '') {
        sh.getRange(i + 1, 6).setValue(Number(p.stock));
      }
      if (p.lowStockThreshold !== undefined && p.lowStockThreshold !== null && p.lowStockThreshold !== '') {
        sh.getRange(i + 1, 7).setValue(Number(p.lowStockThreshold));
      }
      return { ok: true };
    }
  }
  return { ok: false, error: 'Product not found' };
}

// ---------------------------------------------------------------------------
// 6b. LIVE STOCK / INVENTORY
// ---------------------------------------------------------------------------
// Authorizes a stock change either via Super Admin creds, or via a biller's
// own login credentials - gated by the CanAccessStockEdit toggle (or, for
// read-style checks, CanAccessStockView/Edit either one). Mirrors the same
// pattern as authorizeBillEdit_ so it behaves identically to the existing
// Find/Edit-access model the super admin already understands.
function authorizeStockAccess_(p, needEdit) {
  const su = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (su.ok) return { ok: true, performerRole: 'Super Admin', performerName: 'Super Admin', performerId: '' };

  if (p.billerId && p.billerPassword) {
    const sh = ss_().getSheetByName(SHEET.BILLERS);
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const [id, name, pass, active, , , , , canStockView, canStockEdit] = data[i];
      if (String(id) === String(p.billerId) && String(pass) === String(p.billerPassword)) {
        const isActive = active === true || String(active).toUpperCase() === 'TRUE';
        const hasView = canStockView === true || String(canStockView).toUpperCase() === 'TRUE';
        const hasEdit = canStockEdit === true || String(canStockEdit).toUpperCase() === 'TRUE';
        if (!isActive) return { ok: false, error: 'This biller ID is deactivated' };
        if (needEdit && !hasEdit) return { ok: false, error: 'This biller does not have Stock Edit access' };
        if (!needEdit && !hasView && !hasEdit) return { ok: false, error: 'This biller does not have Stock View access' };
        return { ok: true, performerRole: 'Biller', performerName: name, performerId: id };
      }
    }
    return { ok: false, error: 'Invalid biller credentials' };
  }
  return { ok: false, error: 'Super admin credentials, or a biller with Stock access, are required' };
}

function apiSetProductStock(p) {
  const auth = authorizeStockAccess_(p, true);
  if (!auth.ok) return auth;

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = ss_().getSheetByName(SHEET.PRODUCTS);
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(p.productId)) {
        const current = (data[i][5] === '' || data[i][5] === null || data[i][5] === undefined) ? 0 : Number(data[i][5]);
        let newStock;
        if (p.mode === 'adjust') {
          newStock = current + Number(p.value || 0);
        } else {
          newStock = Number(p.value);
        }
        if (isNaN(newStock)) return { ok: false, error: 'Invalid stock value' };
        if (newStock < 0) return { ok: false, error: 'Stock cannot be set below zero' };
        sh.getRange(i + 1, 6).setValue(newStock);
        if (p.lowStockThreshold !== undefined && p.lowStockThreshold !== null && p.lowStockThreshold !== '') {
          sh.getRange(i + 1, 7).setValue(Number(p.lowStockThreshold) || 0);
        }
        // Only log a real, non-zero change - a Save that leaves the stock
        // number exactly where it was isn't an actual inventory event, and
        // writing one just adds noise to the Inventory Log Report.
        const delta = newStock - current;
        if (delta !== 0) {
          logStockChange_(data[i][0], data[i][1], 'Manual Adjustment', delta, newStock, '',
            auth.performerRole, auth.performerName, auth.performerId);
          if (delta > 0) buildDailyReportSheet_(); // a real stock addition changes today's Daily Report row
        }
        return { ok: true, productId: data[i][0], newStock: newStock };
      }
    }
    return { ok: false, error: 'Product not found' };
  } finally {
    lock.releaseLock();
  }
}

// Deducts (sign=-1) or restores (sign=+1) stock for a set of bill line items,
// matched by product NAME (bill items are stored by name, not ID). Only
// touches products that are actually being tracked (Stock cell non-blank) -
// an untracked product simply isn't affected, by design. Used both for a
// fresh bill save and for reconciling a bill edit (old items restored,
// new items deducted) so the running stock count always matches reality.
function applyStockChangeForItems_(items, billId, performerRole, performerName, performerId, sign) {
  if (!items || !items.length) return;
  const sh = ss_().getSheetByName(SHEET.PRODUCTS);
  const data = sh.getDataRange().getValues();
  items.forEach(it => {
    const qty = Number(it.qty) || 0;
    if (!qty) return;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][1]).trim().toLowerCase() === String(it.name).trim().toLowerCase()) {
        const stockRaw = data[i][5];
        const tracked = stockRaw !== '' && stockRaw !== null && stockRaw !== undefined;
        if (!tracked) return;
        const current = Number(stockRaw) || 0;
        const delta = sign * qty;
        const newStock = current + delta;
        sh.getRange(i + 1, 6).setValue(newStock);
        data[i][5] = newStock; // keep in sync if the same product appears twice in one bill
        logStockChange_(data[i][0], data[i][1], sign < 0 ? 'Sale' : 'Edit Reversal', delta, newStock, billId || '',
          performerRole, performerName, performerId);
        return;
      }
    }
  });
}

// Writes one StockLog row. Performer identity is stored as three CLEAN,
// SEPARATE fields (role / name / id) rather than one free-text string that
// has to be regex-parsed back apart later - that's what used to cause a
// Biller's own sales to show up with their whole "Name (ID)" label dumped
// into the Name column and nothing in the ID column, while Super Admin
// actions showed their login username in the "Biller ID" column (which
// isn't a biller ID at all). PerformerId is only ever populated for an
// actual Biller - Super Admin and System entries correctly leave it blank.
function logStockChange_(productId, productName, changeType, delta, newStock, billId, performerRole, performerName, performerId) {
  const sh = ss_().getSheetByName(SHEET.STOCK_LOG);
  if (!sh) return;
  const role = performerRole || 'System';
  const name = performerName || 'System';
  const id = performerId || '';
  const legacyLabel = id ? (role + ': ' + name + ' (' + id + ')') : (role + ': ' + name);
  sh.appendRow([new Date(), productId, productName, changeType, delta, newStock, billId || '', legacyLabel, role, name, id]);
}

function apiGetStockLog(params) {
  const sh = ss_().getSheetByName(SHEET.STOCK_LOG);
  if (!sh) return { ok: true, log: [] };
  const data = sh.getDataRange().getValues();
  const productId = (params && params.productId) || '';
  const log = [];
  for (let i = data.length - 1; i >= 1 && log.length < 60; i--) {
    const row = data[i];
    if (!row[0]) continue;
    if (productId && String(row[1]) !== String(productId)) continue;
    log.push({
      timestamp: row[0], productId: row[1], productName: row[2], changeType: row[3],
      delta: row[4], newStock: row[5], billId: row[6], performedBy: row[7],
      performerRole: row[8] || '', performerName: row[9] || '', performerId: row[10] || ''
    });
  }
  return { ok: true, log: log };
}

function apiDeleteProduct(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const sh = ss_().getSheetByName(SHEET.PRODUCTS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.productId)) {
      sh.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Product not found' };
}

// ---------------------------------------------------------------------------
// 7. BILLERS (admin managed)
// ---------------------------------------------------------------------------
function apiGetBillers() {
  const sh = ss_().getSheetByName(SHEET.BILLERS);
  const data = sh.getDataRange().getValues();
  const billers = [];
  for (let i = 1; i < data.length; i++) {
    const [id, name, pass, active, , canTax, canBank, canFindEdit, canStockView, canStockEdit, canReportDownload, canDiscount, canDashboard] = data[i];
    if (!id) continue;
    billers.push({
      billerId: id, name: name,
      active: active === true || String(active).toUpperCase() === 'TRUE',
      canAccessTax: canTax === true || String(canTax).toUpperCase() === 'TRUE',
      canAccessBank: canBank === true || String(canBank).toUpperCase() === 'TRUE',
      canAccessFindEdit: canFindEdit === true || String(canFindEdit).toUpperCase() === 'TRUE',
      canAccessStockView: canStockView === true || String(canStockView).toUpperCase() === 'TRUE',
      canAccessStockEdit: canStockEdit === true || String(canStockEdit).toUpperCase() === 'TRUE',
      canAccessReportDownload: canReportDownload === true || String(canReportDownload).toUpperCase() === 'TRUE',
      canAccessDiscount: canDiscount === true || String(canDiscount).toUpperCase() === 'TRUE',
      canAccessDashboard: canDashboard === true || String(canDashboard).toUpperCase() === 'TRUE'
    });
  }
  return { ok: true, billers: billers };
}

function apiSaveBiller(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const sh = ss_().getSheetByName(SHEET.BILLERS);
  if (p.editBillerId) {
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(p.editBillerId)) {
        sh.getRange(i + 1, 2).setValue(p.name);
        if (p.password) sh.getRange(i + 1, 3).setValue(p.password);
        return { ok: true, billerId: p.editBillerId };
      }
    }
    return { ok: false, error: 'Biller not found' };
  }
  const id = 'B' + Utilities.formatString('%03d', sh.getLastRow());
  sh.appendRow([id, p.name, p.password, true, new Date()]);
  return { ok: true, billerId: id };
}

function apiToggleBiller(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const sh = ss_().getSheetByName(SHEET.BILLERS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.billerId)) {
      const cur = data[i][3] === true || String(data[i][3]).toUpperCase() === 'TRUE';
      sh.getRange(i + 1, 4).setValue(!cur);
      return { ok: true, active: !cur };
    }
  }
  return { ok: false, error: 'Biller not found' };
}

// field must be one of: canAccessTax, canAccessBank, canAccessFindEdit,
// canAccessStockView, canAccessStockEdit, canAccessReportDownload,
// canAccessDiscount, canAccessDashboard
function apiSetBillerAccess(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const colMap = {
    canAccessTax: 6, canAccessBank: 7, canAccessFindEdit: 8,
    canAccessStockView: 9, canAccessStockEdit: 10, canAccessReportDownload: 11,
    canAccessDiscount: 12, canAccessDashboard: 13
  };
  const col = colMap[p.field];
  if (!col) return { ok: false, error: 'Unknown permission field' };
  const sh = ss_().getSheetByName(SHEET.BILLERS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.billerId)) {
      sh.getRange(i + 1, col).setValue(!!p.value);
      // Stock View/Edit are a two-level permission: Edit is meaningless
      // without View, so granting Edit auto-grants View, and revoking
      // View auto-revokes Edit. This is enforced server-side too (not
      // just in the UI) so the two toggles can never end up inconsistent.
      if (p.field === 'canAccessStockEdit' && p.value) {
        sh.getRange(i + 1, colMap.canAccessStockView).setValue(true);
      }
      if (p.field === 'canAccessStockView' && !p.value) {
        sh.getRange(i + 1, colMap.canAccessStockEdit).setValue(false);
      }
      return { ok: true };
    }
  }
  return { ok: false, error: 'Biller not found' };
}

function apiDeleteBiller(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const sh = ss_().getSheetByName(SHEET.BILLERS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.billerId)) {
      sh.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Biller not found' };
}

// ---------------------------------------------------------------------------
// 8. BILL ID / GENERIC ID HELPERS
// ---------------------------------------------------------------------------
// IDs are generated from a counter stored in this Apps Script PROJECT's own
// Script Properties - NOT from counting rows in whichever spreadsheet is
// currently active. This is what makes numbering survive an archive switch:
// the counter belongs to the script, not to any one spreadsheet, so
// SJP-004821 is always followed by SJP-004822 even if that next bill lands
// in a brand-new spreadsheet. The very first time a counter is used, it
// bootstraps itself from the highest ID already present (checking the
// active spreadsheet AND every archive), so turning this on for the first
// time on a spreadsheet that already has data never collides with
// already-issued IDs.
//
// IMPORTANT - every caller of nextSequentialId_ must already be holding
// LockService.getScriptLock() for its whole read-then-write sequence
// (Apps Script only provides ONE script-wide lock, so this function
// deliberately does NOT acquire its own - nesting two waitLock() calls in
// the same execution is unnecessary risk in a billing system). See
// apiSaveBill, apiSaveCustomer and apiAddProduct for the pattern.
// consume=false is a pure PREVIEW - it computes what the next ID would be
// without persisting anything, so apiBootstrap can safely show "Next
// Invoice: SJP-004822" every time a biller opens the billing screen without
// burning a real ID on every page load. consume=true (the default) is the
// real, ID-issuing path and must only ever be called once per actual save,
// from inside a function that's already holding LockService.getScriptLock()
// for its whole read-then-write sequence - see the note above nextId_.
function nextSequentialId_(counterKey, prefix, padLength, bootstrapSheet, idColIndex, consume) {
  if (consume === undefined) consume = true;
  const props = PropertiesService.getScriptProperties();
  let current = Number(props.getProperty(counterKey));
  if (!current || isNaN(current)) {
    current = highestExistingIdSuffix_(bootstrapSheet, idColIndex);
    openArchives_().forEach(a => {
      const sh = bootstrapSheet ? a.ss.getSheetByName(bootstrapSheet.getName()) : null;
      if (sh) current = Math.max(current, highestExistingIdSuffix_(sh, idColIndex));
    });
  }
  const next = current + 1;
  if (consume) props.setProperty(counterKey, String(next));
  return prefix + '-' + Utilities.formatString('%0' + padLength + 'd', next);
}

function highestExistingIdSuffix_(sheet, idColIndex) {
  if (!sheet) return 0;
  const data = sheet.getDataRange().getValues();
  let max = 0;
  for (let i = 1; i < data.length; i++) {
    const id = String(data[i][idColIndex] || '');
    const m = id.match(/(\d+)\s*$/);
    if (m) { const n = Number(m[1]); if (n > max) max = n; }
  }
  return max;
}

function nextId_(sheet, prefix) {
  return nextSequentialId_('IDCTR_' + prefix, prefix, 4, sheet, 0, true);
}

function nextBillId_() {
  const sh = ss_().getSheetByName(SHEET.BILLS);
  return nextSequentialId_('IDCTR_SJP', 'SJP', 6, sh, 0, true);
}

// Read-only preview for apiBootstrap - see the note above nextSequentialId_.
function peekNextBillId_() {
  const sh = ss_().getSheetByName(SHEET.BILLS);
  return nextSequentialId_('IDCTR_SJP', 'SJP', 6, sh, 0, false);
}

// ---------------------------------------------------------------------------
// 9. SAVE BILL  (core transaction)
// ---------------------------------------------------------------------------
function apiSaveBill(p) {
  // 1. Verify biller credentials - mandatory to save any bill
  const billerCheck = apiVerifyBiller({ billerId: p.billerId, password: p.billerPassword });
  if (!billerCheck.ok) return billerCheck;

  if (!p.customerName || !p.phone || !p.date) {
    return { ok: false, error: 'Customer name, phone and date are mandatory' };
  }
  if (!p.items || !p.items.length) {
    return { ok: false, error: 'Add at least one product' };
  }

  // 1b. Hard stop if the active spreadsheet is essentially full - this is
  // the server-side enforcement behind the "Database Full" popup on the
  // Create Bill screen. Checked here (not just shown in the UI) so a
  // stale page or a direct API call can't slip a bill through.
  const capacity = apiGetCapacityStatus();
  if (capacity.ok && capacity.blocked) {
    return {
      ok: false,
      dbFull: true,
      error: 'This database is full and cannot accept new bills. Ask your Super Admin to add a new database (Admin Settings → Data Continuity) - it only takes one click.'
    };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // 2. Resolve / create customer
    let customerId = p.customerId;
    if (!customerId) {
      const found = apiFindCustomer(p.phone, p.customerName);
      if (found.found) {
        customerId = found.customer.customerId;
        updateCustomerIfChanged_(customerId, p);
      } else {
        customerId = apiSaveCustomer(p, true).customerId;
      }
    }

    // 3. Compute totals - item-level discounts, then the bill-level
    // "additional discount", then tax (if switched on) - all in one place
    // so this exactly matches what the live preview showed the biller.
    // Server is the source of truth for BOTH tax/bank AND discount: a
    // biller without Discount access can never have a discount land on a
    // saved bill, no matter what the client sent (stale session, tampered
    // request, etc.) - mirrors the existing tax/bank enforcement below.
    const settingsMap = getSettingsMap_();
    let taxOverride = (p.taxOverride === 'TRUE' || p.taxOverride === 'FALSE') ? p.taxOverride : '';
    let bankOverride = (p.bankOverride === 'TRUE' || p.bankOverride === 'FALSE') ? p.bankOverride : '';
    if (!billerCheck.canAccessTax) taxOverride = 'FALSE';
    if (!billerCheck.canAccessBank) bankOverride = 'FALSE';

    let itemsForCalc = p.items;
    let totalDiscountPct = Number(p.discountPercent) || 0;
    if (!billerCheck.canAccessDiscount) {
      itemsForCalc = p.items.map(it => Object.assign({}, it, { discountPercent: 0 }));
      totalDiscountPct = 0;
    }
    const totals = computeBillTotals_(itemsForCalc, totalDiscountPct, taxOverride, settingsMap);
    const totalQty = itemsForCalc.reduce((s, it) => s + (Number(it.qty) || 0), 0);
    const totalAmount = totals.netAmount; // what's actually owed, pre-tax - tax is presentation-time on top, same as before

    // 4. Bill ID
    const billsSh = ss_().getSheetByName(SHEET.BILLS);
    const billId = nextBillId_();

    // 5. Payment handling
    let paymentStatus = 'Cash Collected';
    let qrImageUrl = '', qrId = '', paymentLink = '';
    if (p.paymentMethod === 'UPI') {
      const rp = createRazorpayUpiQr_(billId, totalAmount);
      if (!rp.ok) {
        return { ok: false, error: 'Razorpay QR creation failed: ' + rp.error };
      }
      paymentStatus = 'Pending';
      qrImageUrl = rp.imageUrl;
      qrId = rp.qrId;
      paymentLink = rp.imageUrl;
    }

    // 6. Write Bill row
    billsSh.appendRow([
      billId, p.date, customerId, p.customerName, p.phone, p.email || '', p.address || '',
      p.deliveryAddress || '', p.paymentMethod, totalQty, totalAmount, paymentStatus,
      billerCheck.billerId, billerCheck.billerName, qrId, '', new Date(), new Date(), '', '',
      taxOverride, bankOverride, totals.totalDiscPct
    ]);

    // 7. Write BillItems rows - LineTotal is the DISCOUNTED total (what's
    // actually billed for that line); DiscountPercent is kept alongside it
    // so the original price and the discount are both still visible later.
    const itemsSh = ss_().getSheetByName(SHEET.BILL_ITEMS);
    totals.items.forEach(it => {
      itemsSh.appendRow([billId, it.name, it.price, it.qty, it.lineTotal, it.discountPercent]);
    });

    // 7b. Deduct live stock for any tracked products in this bill (no-op for
    // products that have never had a stock value set - see apiGetProducts).
    applyStockChangeForItems_(p.items, billId, 'Biller', billerCheck.billerName, billerCheck.billerId, -1);

    buildDashboardSheet();
    buildUniversalReportSheet_();
    buildDailyReportSheet_();

    return {
      ok: true, billId: billId, customerId: customerId, totalAmount: totalAmount,
      totalQty: totalQty, paymentStatus: paymentStatus, qrImageUrl: qrImageUrl,
      paymentLink: paymentLink
    };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// 10. RAZORPAY - CREATE UPI QR (server-to-server, key never touches frontend)
// ---------------------------------------------------------------------------
function createRazorpayUpiQr_(billId, amount) {
  const s = getSettingsMap_();
  const keyId = s.RazorpayKeyId, keySecret = s.RazorpayKeySecret;
  if (!keyId || !keySecret) return { ok: false, error: 'Razorpay keys not set in Settings' };

  const payload = {
    type: 'upi_qr',
    name: 'Bill ' + billId,
    usage: 'single_use',
    fixed_amount: true,
    payment_amount: Math.round(amount * 100), // paise
    description: 'SJ Physiotherapy - ' + billId,
    close_by: Math.floor(Date.now() / 1000) + 60 * 60 * 24, // valid 24h
    notes: { billId: billId }
  };

  const res = UrlFetchApp.fetch('https://api.razorpay.com/v1/qr_codes', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(keyId + ':' + keySecret) },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const body = JSON.parse(res.getContentText());
  if (code >= 200 && code < 300) {
    return { ok: true, qrId: body.id, imageUrl: body.image_url };
  }
  return { ok: false, error: (body.error && body.error.description) || res.getContentText() };
}

// ---------------------------------------------------------------------------
// 11. RAZORPAY WEBHOOK HANDLER
// ---------------------------------------------------------------------------
function handleRazorpayWebhook_(e, settings) {
  const raw = e.postData.contents;
  logPayment_('WebhookReceived', '', '', '', raw);
  try {
    const body = JSON.parse(raw);
    const event = body.event;
    if (event === 'qr_code.credited') {
      const qr = body.payload.qr_code.entity;
      const payment = body.payload.payment.entity;
      confirmPaymentServerSide_(qr.id, payment.id, settings);
    }
    return jsonOut({ ok: true });
  } catch (err) {
    logPayment_('WebhookError', '', '', '', String(err));
    return jsonOut({ ok: false, error: String(err) });
  }
}

// Extra safety: re-confirm the payment status directly with Razorpay's API
// before marking a bill Paid (protects against a spoofed call to our URL).
function confirmPaymentServerSide_(qrId, paymentId, settings) {
  const keyId = settings.RazorpayKeyId, keySecret = settings.RazorpayKeySecret;
  const res = UrlFetchApp.fetch('https://api.razorpay.com/v1/payments/' + paymentId, {
    method: 'get',
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(keyId + ':' + keySecret) },
    muteHttpExceptions: true
  });
  const body = JSON.parse(res.getContentText());
  if (body.status !== 'captured') {
    logPayment_('PaymentNotCaptured', '', qrId, paymentId, JSON.stringify(body));
    return;
  }
  markBillPaidByQrId_(qrId, paymentId);
}

function markBillPaidByQrId_(qrId, paymentId) {
  const sh = ss_().getSheetByName(SHEET.BILLS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][14]) === String(qrId)) { // col O = RazorpayQrId
      sh.getRange(i + 1, 12).setValue('Paid');       // col L = PaymentStatus
      sh.getRange(i + 1, 16).setValue(paymentId);    // col P = RazorpayPaymentId
      sh.getRange(i + 1, 18).setValue(new Date());   // col R = UpdatedAt
      logPayment_('PaymentConfirmed', data[i][0], qrId, paymentId, 'OK');
      return;
    }
  }
  logPayment_('BillNotFoundForQr', '', qrId, paymentId, 'No matching bill row');
}

function logPayment_(eventName, billId, qrId, paymentId, raw) {
  const sh = ss_().getSheetByName(SHEET.PAYMENT_LOGS);
  sh.appendRow([new Date(), billId, eventName, qrId, paymentId, raw]);
}

// Manual "check now" button on the frontend - polls Razorpay directly in
// case the webhook is delayed or not yet configured.
function apiCheckQrStatusNow(p) {
  const s = getSettingsMap_();
  const keyId = s.RazorpayKeyId, keySecret = s.RazorpayKeySecret;
  const res = UrlFetchApp.fetch('https://api.razorpay.com/v1/qr_codes/' + p.qrId + '/payments', {
    method: 'get',
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(keyId + ':' + keySecret) },
    muteHttpExceptions: true
  });
  const body = JSON.parse(res.getContentText());
  if (body.items && body.items.length) {
    const payment = body.items[0];
    if (payment.status === 'captured') {
      markBillPaidByQrId_(p.qrId, payment.id);
      return { ok: true, status: 'Paid' };
    }
  }
  return { ok: true, status: 'Pending' };
}

// ---------------------------------------------------------------------------
// 12. BILL STATUS / LOOKUP / EDIT
// ---------------------------------------------------------------------------
// Searches the active spreadsheet first, then every archive - so a bill
// from years ago is found exactly as reliably as one from this morning.
function apiGetBillStatus(billId) {
  for (const db of allDbs_()) {
    const sh = db.ss.getSheetByName(SHEET.BILLS);
    if (!sh) continue;
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(billId)) {
        return { ok: true, status: data[i][11], source: db.label, editable: db.label === 'Active' };
      }
    }
  }
  return { ok: false, error: 'Bill not found' };
}

function apiGetBill(billId) {
  let billRow = null, foundDb = null;
  for (const db of allDbs_()) {
    const sh = db.ss.getSheetByName(SHEET.BILLS);
    if (!sh) continue;
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(billId)) { billRow = data[i]; foundDb = db; break; }
    }
    if (billRow) break;
  }
  if (!billRow) return { ok: false, error: 'Bill not found' };

  // Line items always live in the SAME spreadsheet as the bill itself.
  const itemsSh = foundDb.ss.getSheetByName(SHEET.BILL_ITEMS);
  const itemsData = itemsSh.getDataRange().getValues();
  const items = [];
  for (let i = 1; i < itemsData.length; i++) {
    if (String(itemsData[i][0]) === String(billId)) {
      items.push({
        name: itemsData[i][1], price: itemsData[i][2], qty: itemsData[i][3], total: itemsData[i][4],
        discountPercent: Number(itemsData[i][5]) || 0
      });
    }
  }

  return {
    ok: true,
    bill: {
      billId: billRow[0], date: billRow[1], customerId: billRow[2], customerName: billRow[3],
      phone: billRow[4], email: billRow[5], address: billRow[6], deliveryAddress: billRow[7],
      paymentMethod: billRow[8], totalQty: billRow[9], totalAmount: billRow[10],
      paymentStatus: billRow[11], billerId: billRow[12], billerName: billRow[13],
      updatedBy: billRow[18], versionNote: billRow[19],
      taxOverride: billRow[20] || '', bankOverride: billRow[21] || '',
      discountPercent: Number(billRow[22]) || 0,
      items: items,
      source: foundDb.label,
      editable: foundDb.label === 'Active'
    }
  };
}

// ---------------------------------------------------------------------------
// 8b. EMAIL BILL AS PDF
//     Rebuilds a simple standalone invoice layout from the saved bill data
//     (independent of the on-screen preview) and emails it as a PDF
//     attachment via MailApp. The very first time this runs after a fresh
//     deployment, Google will prompt to authorize an extra "send email"
//     permission - that's expected, just accept it once.
// ---------------------------------------------------------------------------
function apiEmailBillPdf(p) {
  const email = String(p.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Please enter a valid email address' };
  }
  const res = apiGetBill(p.billId);
  if (!res.ok) return res;
  const bill = res.bill;
  const s = apiGetSettingsPublic().settings;
  const totals = computeBillTotals_(bill.items, bill.discountPercent, bill.taxOverride, s);
  const tax = totals.tax;

  try {
    const html = buildBillHtmlForPdf_(bill, s, totals);
    const pdfBlob = HtmlService.createHtmlOutput(html).getAs('application/pdf').setName('Bill-' + bill.billId + '.pdf');
    MailApp.sendEmail({
      to: email,
      name: s.CompanyName || 'SJ Physiotherapy',
      subject: 'Invoice ' + bill.billId + ' - ' + (s.CompanyName || 'SJ Physiotherapy'),
      htmlBody: 'Hi ' + escHtml_(bill.customerName || '') + ',<br><br> Here is your Invoice ' +
        '<b>' + escHtml_(String(bill.billId)) + '</b> for <b>₹' + tax.grandTotal.toFixed(2) + '</b>.' +
        '<br><br>Thank you for shopping with ' + escHtml_(s.CompanyName || 'us') + '!',
      attachments: [pdfBlob]
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'Could not send email: ' + err.message };
  }
}

// Tax is OFF by default for every bill - it must be explicitly switched on
// per bill (and only a biller with Tax access can do that; enforced by the
// caller, not here). taxOverride is the literal 'TRUE'/'FALSE' string
// stored on the Bills row; anything else (blank/unset) means off.
function computeTax_(subTotal, s, taxOverride) {
  const cgstPct = Number(s.CGSTPercent) || 0;
  const sgstPct = Number(s.SGSTPercent) || 0;
  const showTax = taxOverride === 'TRUE';
  const cgst = cgstPct >= 1 ? Math.round(subTotal * cgstPct) / 100 : 0;
  const sgst = sgstPct >= 1 ? Math.round(subTotal * sgstPct) / 100 : 0;
  const taxTotal = cgst + sgst;
  const showTaxSection = showTax && (cgstPct >= 1 || sgstPct >= 1);
  return {
    cgstPct: cgstPct >= 1 ? cgstPct : 0,
    sgstPct: sgstPct >= 1 ? sgstPct : 0,
    cgstAmount: cgst, sgstAmount: sgst, taxTotal,
    // Tax only ever lands in the grand total when it's actually switched ON
    // for this specific bill - never silently folded in just because a
    // CGST/SGST % happens to be configured in Admin Settings.
    grandTotal: subTotal + (showTaxSection ? taxTotal : 0),
    showTaxSection
  };
}

// Single source of truth for turning a list of raw line items + an optional
// bill-level discount % into every number the bill needs - used at save
// time, at edit time (recomputed server-side, never trusted from the
// client), and when rebuilding a saved bill for the emailed PDF. Discount
// order: each item's own % first, THEN the bill-level "additional discount"
// % on what's left, THEN tax (if switched on) on what's left after that.
function computeBillTotals_(items, totalDiscountPct, taxOverride, s) {
  let grossSubtotal = 0, itemDiscountTotal = 0;
  const lineDetails = (items || []).map(function (it) {
    const price = Number(it.price) || 0;
    const qty = Number(it.qty) || 0;
    const discPct = Math.min(100, Math.max(0, Number(it.discountPercent != null ? it.discountPercent : it.discountPct) || 0));
    const gross = price * qty;
    const lineDiscountAmount = gross * discPct / 100;
    const lineTotal = gross - lineDiscountAmount;
    grossSubtotal += gross;
    itemDiscountTotal += lineDiscountAmount;
    return { name: it.name, price: price, qty: qty, discountPercent: discPct, gross: gross, lineTotal: lineTotal };
  });
  const afterItemDiscount = grossSubtotal - itemDiscountTotal;
  const totalDiscPct = Math.min(100, Math.max(0, Number(totalDiscountPct) || 0));
  const totalDiscountAmount = afterItemDiscount * totalDiscPct / 100;
  const netAmount = afterItemDiscount - totalDiscountAmount;
  const tax = computeTax_(netAmount, s, taxOverride);
  return {
    items: lineDetails,
    grossSubtotal: grossSubtotal,
    itemDiscountTotal: itemDiscountTotal,
    afterItemDiscount: afterItemDiscount,
    totalDiscPct: totalDiscPct,
    totalDiscountAmount: totalDiscountAmount,
    netAmount: netAmount,
    tax: tax,
    grandTotal: tax.grandTotal
  };
}

function getLogoDataUri_(url) {
  if (!url) return '';
  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return '';
    const blob = resp.getBlob();
    const contentType = blob.getContentType() || 'image/png';
    const base64 = Utilities.base64Encode(blob.getBytes());
    return 'data:' + contentType + ';base64,' + base64;
  } catch (err) {
    return ''; // If the logo can't be fetched, skip it rather than fail/slow down the whole email.
  }
}

function buildBillHtmlForPdf_(bill, s, totals) {
  const tax = totals.tax;
  const hasAnyItemDiscount = totals.itemDiscountTotal > 0.004;
  const rows = totals.items.map(function (i) {
    const discCell = i.discountPercent > 0
      ? '<td class="num disc">-' + i.discountPercent + '%</td>'
      : (hasAnyItemDiscount ? '<td class="num disc">-</td>' : '');
    return '<tr><td>' + escHtml_(i.name) + '</td><td class="num">₹' + Number(i.price).toFixed(2) +
      '</td><td class="num">' + i.qty + '</td>' + discCell +
      '<td class="num">₹' + Number(i.lineTotal).toFixed(2) + '</td></tr>';
  }).join('');
  const tableHead = '<tr><th>Product / Service</th><th class="num">Price</th><th class="num">Qty</th>' +
    (hasAnyItemDiscount ? '<th class="num">Discount</th>' : '') + '<th class="num">Total</th></tr>';

  let totalsRows = '<div class="row"><span>Total Qty</span><span>' + bill.totalQty + '</span></div>';
  totalsRows += '<div class="row"><span>Item Subtotal</span><span>₹' + totals.grossSubtotal.toFixed(2) + '</span></div>';
  if (hasAnyItemDiscount) {
    totalsRows += '<div class="row disc"><span>Item Discounts</span><span>-₹' + totals.itemDiscountTotal.toFixed(2) + '</span></div>';
  }
  if (totals.totalDiscPct > 0) {
    totalsRows += '<div class="row disc"><span>Additional Discount (' + totals.totalDiscPct + '%)</span><span>-₹' + totals.totalDiscountAmount.toFixed(2) + '</span></div>';
  }
  if (hasAnyItemDiscount || totals.totalDiscPct > 0) {
    totalsRows += '<div class="row"><span>Net Amount</span><span>₹' + totals.netAmount.toFixed(2) + '</span></div>';
  }
  if (tax.showTaxSection) {
    if (tax.cgstPct >= 1) totalsRows += '<div class="row"><span>CGST @ ' + tax.cgstPct + '%</span><span>₹' + tax.cgstAmount.toFixed(2) + '</span></div>';
    if (tax.sgstPct >= 1) totalsRows += '<div class="row"><span>SGST @ ' + tax.sgstPct + '%</span><span>₹' + tax.sgstAmount.toFixed(2) + '</span></div>';
    totalsRows += '<div class="row"><span>Tax Total</span><span>₹' + tax.taxTotal.toFixed(2) + '</span></div>';
  }
  totalsRows += '<div class="row grand"><span>Grand Total</span><span>₹' + tax.grandTotal.toFixed(2) + '</span></div>';

  const logo = getLogoDataUri_(s.PrintLogoURL || s.LogoURL || '');
  const metaLines = [];
  if (s.Address) metaLines.push(escHtml_(s.Address));
  const contactBits = [];
  if (s.Phone) contactBits.push(escHtml_(s.Phone));
  if (s.ShowCompanyEmail !== false && s.CompanyEmail) contactBits.push(escHtml_(s.CompanyEmail));
  if (contactBits.length) metaLines.push(contactBits.join(' | '));
  if (s.Website) metaLines.push(escHtml_(s.Website));
  if (s.GSTNumber) metaLines.push('GSTIN: ' + escHtml_(s.GSTNumber));

  const leftMeta = [
    'Date: <b>' + escHtml_(formatDate_(bill.date)) + '</b>',
    'Customer: <b>' + escHtml_(bill.customerName || '') + '</b>',
    'Customer ID: <b>' + escHtml_(bill.customerId || '') + '</b>',
    'Phone: <b>' + escHtml_(bill.phone || '') + '</b>'
  ];
  if (bill.email) leftMeta.push('Email: <b>' + escHtml_(bill.email) + '</b>');

  const rightMeta = ['Payment Method: <b>' + escHtml_(paymentMethodLabel_(bill.paymentMethod)) + '</b>'];
  if (bill.address) rightMeta.push('Billing Address: <b>' + escHtml_(bill.address) + '</b>');
  if (bill.deliveryAddress) rightMeta.push('Delivery Address: <b>' + escHtml_(bill.deliveryAddress) + '</b>');

  let bankHtml = '';
  const showBank = (bill.bankOverride === 'TRUE' || bill.bankOverride === 'FALSE') ? (bill.bankOverride === 'TRUE') : (s.ShowBankDetails !== false);
  if (showBank) {
    const parts = [];
    if (s.BankName) parts.push('Bank: <b>' + escHtml_(s.BankName) + '</b>');
    if (s.BankAccountNo) parts.push('A/c: <b>' + escHtml_(s.BankAccountNo) + '</b>');
    if (s.BankIFSC) parts.push('IFSC: <b>' + escHtml_(s.BankIFSC) + '</b>');
    if (s.BankAccountHolder) parts.push('Holder: <b>' + escHtml_(s.BankAccountHolder) + '</b>');
    if (parts.length) bankHtml = '<div class="bill-bank">' + parts.join(' &nbsp;&middot;&nbsp; ') + '</div>';
  }

  let signHtml = '';
  if (s.ShowAuthorizedSignatory !== false) {
    const label = s.AuthorizedSignatoryLabel || 'Authorized Signatory';
    signHtml = '<div class="bill-sign"><div class="sign-box"></div><div class="sign-label">' + escHtml_(label) + '</div></div>';
  }

  const themeBillHeader = s.ThemeBillHeaderColor || '#E1341E';
  const themeHeading = s.ThemeHeadingColor || '#182322';
  const themeMuted = s.ThemeMutedColor || '#4B5A57';
  const themeBorder = s.ThemeBorderColor || '#E7DCD8';

  // Bill typography - company name and company info (address/phone/etc.)
  // each get their own independent bold/italic/underline switches, and the
  // header can lay the logo out beside the info or stacked above it. Same
  // three settings drive the on-screen preview in app.js (buildCompanyHeadHtml)
  // so print / PDF / email always match exactly what was previewed.
  const isOn_ = function (v) { return String(v == null ? '' : v).trim().toUpperCase() === 'TRUE'; };
  const nameWeight = isOn_(s.ThemeBillCompanyNameBold === undefined ? 'TRUE' : s.ThemeBillCompanyNameBold) ? '800' : '400';
  const nameStyle = isOn_(s.ThemeBillCompanyNameItalic) ? 'italic' : 'normal';
  const nameDecoration = isOn_(s.ThemeBillCompanyNameUnderline) ? 'underline' : 'none';
  const infoWeight = isOn_(s.ThemeBillCompanyInfoBold) ? '700' : '400';
  const infoStyle = isOn_(s.ThemeBillCompanyInfoItalic) ? 'italic' : 'normal';
  const infoDecoration = isOn_(s.ThemeBillCompanyInfoUnderline) ? 'underline' : 'none';
  const headerLayout = s.ThemeBillHeaderLayout === 'logo-top' ? 'logo-top' : 'logo-side';
  const headHtml = headerLayout === 'logo-top'
    ? '<div class="bill-head bill-head-stacked">' +
      '<div class="bill-head-top"><div class="bill-head-info">' +
      (logo ? '<img class="bill-logo" src="' + logo + '">' : '') +
      '</div><div class="bill-tag"><div class="bill-tag-label">Invoice</div><div class="big">' + escHtml_(String(bill.billId)) + '</div></div></div>' +
      '<p class="co-name">' + escHtml_(s.CompanyName || 'Invoice') + '</p><div class="co-meta">' + metaLines.join('<br>') + '</div>' +
      '</div>'
    : '<div class="bill-head">' +
      (logo ? '<img class="bill-logo" src="' + logo + '">' : '') +
      '<div class="bill-head-info"><p class="co-name">' + escHtml_(s.CompanyName || 'Invoice') + '</p><div class="co-meta">' + metaLines.join('<br>') + '</div></div>' +
      '<div class="bill-tag"><div class="bill-tag-label">Invoice</div><div class="big">' + escHtml_(String(bill.billId)) + '</div></div>' +
      '</div>';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;color:' + themeHeading + ';margin:0;padding:26px;font-size:13px;background:#FFFFFE;}' +
    '.bill-head{display:flex;gap:10px;align-items:flex-start;border-bottom:1.5px solid ' + themeHeading + ';padding-bottom:8px;}' +
    '.bill-head-stacked{display:block;}' +
    '.bill-head-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;}' +
    '.bill-logo{width:96px;height:58px;max-width:96px;max-height:58px;border-radius:4px;object-fit:contain;background:#fff;flex-shrink:0;}' +
    '.bill-head-info{flex:1;min-width:0;}' +
    '.co-name{font-size:18px;font-weight:' + nameWeight + ';font-style:' + nameStyle + ';text-decoration:' + nameDecoration + ';margin:0 0 4px;color:' + themeBillHeader + ';}' +
    '.co-meta{font-size:10px;font-weight:' + infoWeight + ';font-style:' + infoStyle + ';text-decoration:' + infoDecoration + ';color:' + themeBillHeader + ';line-height:1.55;margin:0;}' +
    '.bill-tag{margin-left:auto;text-align:right;flex-shrink:0;}' +
    '.bill-tag-label{font-size:10px;color:' + themeMuted + ';text-transform:uppercase;letter-spacing:.3px;}' +
    '.bill-tag .big{font-size:20px;font-weight:800;letter-spacing:1px;color:' + themeBillHeader + ';}' +
    '.bill-meta-grid{display:flex;justify-content:space-between;gap:8px 28px;font-size:12px;margin:14px 0;color:' + themeMuted + ';}' +
    '.bill-meta-col{display:flex;flex-direction:column;gap:3px;}' +
    '.bill-meta-col b{color:' + themeHeading + ';}' +
    '.bill-table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:8px;}' +
    '.bill-table th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.3px;border-bottom:1.5px solid ' + themeHeading + ';padding:6px 4px;color:' + themeMuted + ';}' +
    '.bill-table td{padding:7px 4px;border-bottom:1px solid ' + themeBorder + ';}' +
    '.bill-table td.num,.bill-table th.num{text-align:right;}' +
    '.bill-table td.disc{color:#B23A2E;font-size:11.5px;}' +
    '.bill-totals{margin-top:10px;display:flex;flex-direction:column;align-items:flex-end;gap:2px;}' +
    '.bill-totals .row{display:flex;gap:24px;font-size:13px;width:240px;justify-content:space-between;}' +
    '.bill-totals .row.disc{color:#B23A2E;font-size:12px;}' +
    '.bill-totals .grand{font-size:16px;font-weight:800;border-top:2px solid ' + themeHeading + ';padding-top:6px;margin-top:4px;}' +
    '.bill-foot{margin-top:18px;font-size:11px;color:' + themeMuted + ';border-top:1px dashed ' + themeBorder + ';padding-top:12px;display:flex;justify-content:space-between;align-items:flex-end;gap:16px;}' +
    '.bill-foot-main{flex:1;min-width:0;}' +
    '.bill-bank{margin-top:8px;font-size:10.5px;line-height:1.55;color:' + themeMuted + ';}' +
    '.bill-sign{text-align:center;flex-shrink:0;min-width:120px;}' +
    '.sign-box{width:110px;height:42px;border:1px solid ' + themeBorder + ';border-radius:4px;margin:0 auto 4px;background:#fafafa;}' +
    '.sign-label{font-size:10px;color:' + themeMuted + ';text-transform:uppercase;letter-spacing:.3px;}' +
    '</style></head><body>' +
    headHtml +
    '<div class="bill-meta-grid">' +
    '<div class="bill-meta-col">' + leftMeta.map(function (l) { return '<div>' + l + '</div>'; }).join('') + '</div>' +
    '<div class="bill-meta-col">' + rightMeta.map(function (l) { return '<div>' + l + '</div>'; }).join('') + '</div>' +
    '</div>' +
    '<table class="bill-table"><thead>' + tableHead + '</thead><tbody>' + rows + '</tbody></table>' +
    '<div class="bill-totals">' + totalsRows + '</div>' +
    '<div class="bill-foot">' +
    '<div class="bill-foot-main">Billed by: <b>' + escHtml_(bill.billerName || '') + '</b><br>' +
    'Thank you for shopping with ' + escHtml_(s.CompanyName || 'us') + '!' + bankHtml + '</div>' +
    signHtml +
    '</div>' +
    '</body></html>';
}

function formatDate_(val) {
  if (!val) return '-';
  const d = (val instanceof Date) ? val : new Date(val);
  if (isNaN(d.getTime())) return String(val);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function paymentMethodLabel_(method) {
  if (method === 'Cash') return 'Cash in Hand';
  if (method === 'Bank') return 'Bank Transaction';
  if (method === 'UPI') return 'UPI / Bank Transaction';
  return method || '-';
}

function escHtml_(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Authorizes a bill edit either via Super Admin creds, or via a biller's own
// login credentials - but only if that biller has been granted Find/Edit
// access by the super admin. Returns the label to store in the UpdatedBy column.
function authorizeBillEdit_(p) {
  const su = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (su.ok) return {
    ok: true, updatedByLabel: 'Super Admin (' + (p.superAdminUser || '') + ')',
    performerRole: 'Super Admin', performerName: 'Super Admin', performerId: '',
    canAccessTax: true, canAccessBank: true, canAccessDiscount: true
  };

  if (p.billerId && p.billerPassword) {
    const sh = ss_().getSheetByName(SHEET.BILLERS);
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const [id, name, pass, active, , canTax, canBank, canFindEdit, , , , canDiscount] = data[i];
      if (String(id) === String(p.billerId) && String(pass) === String(p.billerPassword)) {
        const isActive = active === true || String(active).toUpperCase() === 'TRUE';
        const canEdit = canFindEdit === true || String(canFindEdit).toUpperCase() === 'TRUE';
        if (!isActive) return { ok: false, error: 'This biller ID is deactivated' };
        if (!canEdit) return { ok: false, error: 'This biller does not have Find/Edit access' };
        return {
          ok: true, updatedByLabel: 'Biller: ' + name + ' (' + id + ')',
          performerRole: 'Biller', performerName: name, performerId: id,
          canAccessTax: canTax === true || String(canTax).toUpperCase() === 'TRUE',
          canAccessBank: canBank === true || String(canBank).toUpperCase() === 'TRUE',
          canAccessDiscount: canDiscount === true || String(canDiscount).toUpperCase() === 'TRUE'
        };
      }
    }
    return { ok: false, error: 'Invalid biller credentials' };
  }
  return { ok: false, error: 'Super admin credentials, or a biller with Find/Edit access, are required' };
}

function apiUpdateBill(p) {
  const auth = authorizeBillEdit_(p);
  if (!auth.ok) return auth;

  // A reason for the change is mandatory - this is what shows up in the
  // audit trail (VersionNote) and in Reports, so a bill can never be
  // silently altered.
  if (!p.versionNote || !String(p.versionNote).trim()) {
    return { ok: false, error: 'Please enter a reason for this change before saving.' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = ss_().getSheetByName(SHEET.BILLS);
    const data = sh.getDataRange().getValues();
    let rowIdx = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(p.billId)) { rowIdx = i + 1; break; }
    }
    if (rowIdx === -1) {
      // Not in the active spreadsheet - check the archives just to give an
      // honest, specific error instead of a bare "not found" for a bill
      // that does exist, just isn't editable anymore.
      for (const db of openArchives_()) {
        const archiveSh = db.ss.getSheetByName(SHEET.BILLS);
        if (!archiveSh) continue;
        const archiveData = archiveSh.getDataRange().getValues();
        for (let i = 1; i < archiveData.length; i++) {
          if (String(archiveData[i][0]) === String(p.billId)) {
            return { ok: false, error: 'This invoice is in "' + db.label + '" (archived) and is read-only - archived invoices can\'t be edited, the same way a closed financial year\'s books normally aren\'t.' };
          }
        }
      }
      return { ok: false, error: 'Bill not found' };
    }

    const f = p.fields || {};
    const map = { customerName: 4, phone: 5, email: 6, address: 7, deliveryAddress: 8,
                  paymentMethod: 9, paymentStatus: 12 };
    Object.keys(map).forEach(k => {
      if (f[k] !== undefined) sh.getRange(rowIdx, map[k]).setValue(f[k]);
    });

    // Tax/bank/discount are recomputed here, server-side, from scratch -
    // exactly like apiSaveBill - rather than trusting whatever totals the
    // client's edit screen displayed. A biller without Tax/Bank/Discount
    // access can never smuggle one of these into a saved edit.
    let taxOverride = data[rowIdx - 1][20] || '';
    let bankOverride = data[rowIdx - 1][21] || '';
    let totalDiscountPct = Number(data[rowIdx - 1][22]) || 0;
    if (f.taxOverride === 'TRUE' || f.taxOverride === 'FALSE') taxOverride = f.taxOverride;
    if (f.bankOverride === 'TRUE' || f.bankOverride === 'FALSE') bankOverride = f.bankOverride;
    if (f.discountPercent !== undefined) totalDiscountPct = Number(f.discountPercent) || 0;
    if (!auth.canAccessTax) taxOverride = 'FALSE';
    if (!auth.canAccessBank) bankOverride = 'FALSE';
    if (!auth.canAccessDiscount) totalDiscountPct = 0;

    let oldItems = [];
    let newItemsForCalc = null;
    if (f.items) {
      const itemsSh = ss_().getSheetByName(SHEET.BILL_ITEMS);
      const itemsData = itemsSh.getDataRange().getValues();
      for (let i = itemsData.length - 1; i >= 1; i--) {
        if (String(itemsData[i][0]) === String(p.billId)) {
          oldItems.push({ name: itemsData[i][1], qty: itemsData[i][3] });
          itemsSh.deleteRow(i + 1);
        }
      }
      newItemsForCalc = auth.canAccessDiscount
        ? f.items
        : f.items.map(it => Object.assign({}, it, { discountPercent: 0 }));
    }

    // Recompute totals - using either the new items (if this edit touched
    // them) or the bill's existing items, so tax/discount toggle changes
    // alone (no item edits) still land on a correct grand total.
    const settingsMap = getSettingsMap_();
    let itemsForTotals = newItemsForCalc;
    if (!itemsForTotals) {
      const itemsSh2 = ss_().getSheetByName(SHEET.BILL_ITEMS);
      const itemsData2 = itemsSh2.getDataRange().getValues();
      itemsForTotals = [];
      for (let i = 1; i < itemsData2.length; i++) {
        if (String(itemsData2[i][0]) === String(p.billId)) {
          itemsForTotals.push({ name: itemsData2[i][1], price: itemsData2[i][2], qty: itemsData2[i][3], discountPercent: Number(itemsData2[i][5]) || 0 });
        }
      }
    }
    const totals = computeBillTotals_(itemsForTotals, totalDiscountPct, taxOverride, settingsMap);
    const totalQty = itemsForTotals.reduce((s, it) => s + (Number(it.qty) || 0), 0);

    sh.getRange(rowIdx, 10).setValue(totalQty);
    sh.getRange(rowIdx, 11).setValue(totals.netAmount);
    sh.getRange(rowIdx, 21).setValue(taxOverride);
    sh.getRange(rowIdx, 22).setValue(bankOverride);
    sh.getRange(rowIdx, 23).setValue(totals.totalDiscPct);
    sh.getRange(rowIdx, 18).setValue(new Date());
    sh.getRange(rowIdx, 19).setValue(auth.updatedByLabel);
    sh.getRange(rowIdx, 20).setValue('Updated by ' + auth.updatedByLabel + ' on ' + new Date().toLocaleString() +
      ' - ' + String(p.versionNote).trim());

    if (newItemsForCalc) {
      const itemsSh = ss_().getSheetByName(SHEET.BILL_ITEMS);
      totals.items.forEach(it => {
        itemsSh.appendRow([p.billId, it.name, it.price, it.qty, it.lineTotal, it.discountPercent]);
      });

      // Reconcile live stock: give back what the old line items held, then
      // deduct the new line items - so an edited bill never double-counts
      // or silently leaks stock, regardless of what changed.
      applyStockChangeForItems_(oldItems, p.billId, auth.performerRole, auth.performerName, auth.performerId, +1);
      applyStockChangeForItems_(f.items, p.billId, auth.performerRole, auth.performerName, auth.performerId, -1);
    }

    buildDashboardSheet();
    buildUniversalReportSheet_();
    buildDailyReportSheet_();

    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// 13. DASHBOARD AGGREGATION
// ---------------------------------------------------------------------------
// ---- date helpers -----------------------------------------------------
// Parsing a plain "YYYY-MM-DD" string with `new Date(str)` is parsed as
// UTC midnight by the JS spec, while a Sheet's Date cell (and `new Date()`
// on a Date object) is a LOCAL-timezone instant. Mixing the two silently
// shifts the boundary by the timezone offset (5:30 for IST) and can drop
// "today" out of a "today..today" range. Every date used below is first
// normalized to a plain local calendar date (time stripped) so comparisons
// are always apples-to-apples.
function parseDateOnly_(str) {
  if (!str) return null;
  const parts = String(str).split('-');
  if (parts.length !== 3) return null;
  const y = Number(parts[0]), m = Number(parts[1]), d = Number(parts[2]);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
function dateOnly_(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function todayDateOnly_() {
  return dateOnly_(new Date());
}

// Powers every dashboard widget. Each widget on the frontend calls this
// independently with its own filter state: an optional dimension filter
// (customerId OR product - never both) plus an optional date range. Every
// mode below returns real, honestly-computed numbers for every field (no
// "N/A" placeholders) so any widget can pull whichever field it needs.
function apiGetDashboardData(params) {
  const billsSh = ss_().getSheetByName(SHEET.BILLS);
  const bills = billsSh.getDataRange().getValues();
  const itemsSh = ss_().getSheetByName(SHEET.BILL_ITEMS);
  const items = itemsSh.getDataRange().getValues();

  const today = todayDateOnly_();

  // Clamp any future date to today - this is a defense-in-depth backstop;
  // the actual UI prevents picking a future date in the first place.
  let dateFrom = parseDateOnly_(params.dateFrom);
  let dateTo = parseDateOnly_(params.dateTo);
  if (dateFrom && dateFrom > today) dateFrom = today;
  if (dateTo && dateTo > today) dateTo = today;
  if (dateFrom && dateTo && dateFrom > dateTo) { const t = dateFrom; dateFrom = dateTo; dateTo = t; }

  // CustomerID (exact match - names are not unique, IDs are) and Product
  // (exact match, picked from the same product list used on the billing
  // screen) are mutually exclusive per widget. If both somehow arrive
  // together, Customer wins and Product is ignored.
  let customerIdFilter = (params.customerId || '').trim();
  let productFilter = (params.product || '').trim();
  if (customerIdFilter && productFilter) productFilter = '';
  const mode = customerIdFilter ? 'customer' : (productFilter ? 'product' : 'all');

  // Build a lookup of bills within the active date range (and, in
  // 'customer' mode, restricted to that customer) - keyed by BillID.
  const billMeta = {};
  for (let i = 1; i < bills.length; i++) {
    const row = bills[i];
    if (!row[0]) continue;
    const billDate = dateOnly_(new Date(row[1]));
    if (dateFrom && billDate < dateFrom) continue;
    if (dateTo && billDate > dateTo) continue;
    if (mode === 'customer' && String(row[2]).trim().toLowerCase() !== customerIdFilter.toLowerCase()) continue;
    billMeta[String(row[0])] = {
      customerId: String(row[2]),
      paymentMethod: row[8],
      paymentStatus: row[11],
      billerName: row[13] || row[12] || 'Unknown',
      qty: Number(row[9]) || 0,
      amount: Number(row[10]) || 0
    };
  }

  let totalSalesCount = 0, totalSalesAmount = 0, totalQtySold = 0;
  let cashAmount = 0, upiAmount = 0, bankAmount = 0;
  const customerSet = new Set();
  const productTotals = {}; // name -> {qty, amount}
  const billerTotals = {}; // billerName -> {count, amount}

  if (mode === 'product') {
    // Product filtering is an item-level condition - a bill can contain
    // other products too - so every number here is derived from the
    // BillItems rows that match the selected product, not from whole bills.
    const billsWithProduct = new Set();
    for (let i = 1; i < items.length; i++) {
      const row = items[i];
      const billId = String(row[0]);
      const meta = billMeta[billId];
      if (!meta) continue; // outside the active date range
      const name = row[1];
      if (String(name).trim().toLowerCase() !== productFilter.toLowerCase()) continue;
      const qty = Number(row[3]) || 0;
      const amount = Number(row[4]) || 0;
      totalQtySold += qty;
      totalSalesAmount += amount;
      billsWithProduct.add(billId);
      customerSet.add(meta.customerId);
      if (meta.paymentMethod === 'Cash') cashAmount += amount;
      if (meta.paymentMethod === 'Bank') bankAmount += amount;
      if (meta.paymentMethod === 'UPI' && meta.paymentStatus === 'Paid') upiAmount += amount;
      if (!billerTotals[meta.billerName]) billerTotals[meta.billerName] = { count: 0, amount: 0 };
      billerTotals[meta.billerName].amount += amount;
    }
    totalSalesCount = billsWithProduct.size; // bills that contain this product
    if (totalQtySold || totalSalesAmount) {
      productTotals[productFilter] = { qty: totalQtySold, amount: totalSalesAmount };
    }
    billsWithProduct.forEach(id => {
      const bn = billMeta[id].billerName;
      billerTotals[bn].count += 1;
    });
  } else {
    // 'all' or 'customer' - bill-level totals directly from billMeta.
    Object.keys(billMeta).forEach(billId => {
      const meta = billMeta[billId];
      totalSalesCount++;
      totalSalesAmount += meta.amount;
      totalQtySold += meta.qty;
      customerSet.add(meta.customerId);
      if (meta.paymentMethod === 'Cash') cashAmount += meta.amount;
      if (meta.paymentMethod === 'Bank') bankAmount += meta.amount;
      if (meta.paymentMethod === 'UPI' && meta.paymentStatus === 'Paid') upiAmount += meta.amount;
      if (!billerTotals[meta.billerName]) billerTotals[meta.billerName] = { count: 0, amount: 0 };
      billerTotals[meta.billerName].count += 1;
      billerTotals[meta.billerName].amount += meta.amount;
    });
    for (let i = 1; i < items.length; i++) {
      const row = items[i];
      const billId = String(row[0]);
      if (!billMeta[billId]) continue;
      const name = row[1];
      if (!productTotals[name]) productTotals[name] = { qty: 0, amount: 0 };
      productTotals[name].qty += Number(row[3]) || 0;
      productTotals[name].amount += Number(row[4]) || 0;
    }
  }

  const productChart = Object.keys(productTotals).map(name => ({
    name: name, qty: productTotals[name].qty, amount: productTotals[name].amount
  })).sort((a, b) => b.qty - a.qty);

  const billerChart = Object.keys(billerTotals).map(name => ({
    label: name, value: billerTotals[name].count, amount: billerTotals[name].amount
  })).sort((a, b) => b.value - a.value);

  return {
    ok: true,
    serverBuild: BACKEND_BUILD,
    data: {
      mode: mode,
      totalSalesCount: totalSalesCount,
      totalSalesAmount: totalSalesAmount,
      totalQtySold: totalQtySold,
      uniqueCustomers: customerSet.size,
      cashAmount: cashAmount,
      bankAmount: bankAmount,
      upiAmount: upiAmount,
      productChart: productChart,
      billerChart: billerChart,
      // Echoes back exactly what the server understood from the request -
      // check this in the browser console (F12) against what you expected
      // to send. If receivedCustomerId/receivedProduct are blank when you
      // clearly picked a filter, the frontend request isn't reaching here
      // as expected. If they're correct but mode/numbers still look like
      // "all", the fix hasn't been picked up by this deployment yet.
      debug: {
        receivedCustomerId: customerIdFilter,
        receivedProduct: productFilter,
        receivedDateFrom: params.dateFrom || '',
        receivedDateTo: params.dateTo || ''
      }
    }
  };
}

// ---------------------------------------------------------------------------
// 12b. CUSTOM DASHBOARD CHARTS - Super Admin can build their own charts on
//     top of the fixed default widgets above. Stored in the CustomCharts
//     sheet; nothing here can ever touch or delete the DEFAULT dashboard
//     widgets (Total Sales, Product Bar Chart, etc.) since those aren't
//     rows in this sheet at all - they're a separate, hardcoded part of the
//     app. This system only manages the ADDITIONAL charts a shop owner
//     builds for themselves (e.g. "Top 10 products sold", "Top 10
//     customers by spend", "Total Customers" as a number card).
// ---------------------------------------------------------------------------
function apiGetCustomCharts() {
  const sh = ss_().getSheetByName(SHEET.CUSTOM_CHARTS);
  const data = sh.getDataRange().getValues();
  const charts = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;
    charts.push({
      chartId: row[0], name: row[1], type: row[2], dataSource: row[3],
      dimension: row[4], metric: row[5], metricField: row[6],
      topN: Number(row[7]) || 0, sortDir: row[8] || 'desc', sortOrder: Number(row[9]) || 0,
      color: row[11] || ''
    });
  }
  charts.sort((a, b) => a.sortOrder - b.sortOrder);
  return { ok: true, charts: charts };
}

function validateChartDef_(p) {
  const validTypes = ['bar', 'pie', 'donut', 'number'];
  const validSources = ['bills', 'billitems', 'customers', 'products'];
  const validMetrics = ['sum', 'count', 'average'];
  if (!p.name || !String(p.name).trim()) return 'Chart name is required.';
  if (validTypes.indexOf(p.type) === -1) return 'Invalid chart type.';
  if (validSources.indexOf(p.dataSource) === -1) return 'Invalid data source.';
  if (validMetrics.indexOf(p.metric) === -1) return 'Invalid metric.';
  if (p.type !== 'number' && (p.dataSource === 'customers' || p.dataSource === 'products')) {
    return 'Customers/Products can only be used with a Number chart (there\'s nothing to group them by).';
  }
  if (p.type !== 'number' && !p.dimension) return 'Choose a field to group by for this chart type.';
  if ((p.metric === 'sum' || p.metric === 'average') && !p.metricField) return 'Choose which number field to use.';
  return null;
}

// Creates a new custom chart, or updates an existing one if p.chartId is set.
function apiSaveCustomChart(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;

  const err = validateChartDef_(p);
  if (err) return { ok: false, error: err };

  const sh = ss_().getSheetByName(SHEET.CUSTOM_CHARTS);
  const data = sh.getDataRange().getValues();

  if (p.chartId) {
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(p.chartId)) {
        sh.getRange(i + 1, 2, 1, 8).setValues([[
          p.name, p.type, p.dataSource, p.dimension || '', p.metric,
          p.metricField || '', Number(p.topN) || 0, p.sortDir || 'desc'
        ]]);
        sh.getRange(i + 1, 12).setValue(p.color || '');
        return { ok: true, chartId: p.chartId };
      }
    }
    return { ok: false, error: 'Chart not found.' };
  }

  const maxOrder = data.reduce((m, row, i) => i === 0 ? m : Math.max(m, Number(row[9]) || 0), 0);
  const chartId = 'CHART-' + Utilities.getUuid().slice(0, 8).toUpperCase();
  sh.appendRow([
    chartId, p.name, p.type, p.dataSource, p.dimension || '', p.metric,
    p.metricField || '', Number(p.topN) || 0, p.sortDir || 'desc', maxOrder + 1, new Date(), p.color || ''
  ]);
  return { ok: true, chartId: chartId };
}

function apiDeleteCustomChart(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const sh = ss_().getSheetByName(SHEET.CUSTOM_CHARTS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.chartId)) {
      sh.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Chart not found.' };
}

// p.orderedChartIds: array of chartIds in the desired display order.
function apiReorderCustomCharts(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  const orderedIds = p.orderedChartIds;
  if (!Array.isArray(orderedIds)) return { ok: false, error: 'orderedChartIds must be a list.' };

  const sh = ss_().getSheetByName(SHEET.CUSTOM_CHARTS);
  const data = sh.getDataRange().getValues();
  orderedIds.forEach((chartId, idx) => {
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(chartId)) {
        sh.getRange(i + 1, 10).setValue(idx + 1);
        break;
      }
    }
  });
  return { ok: true };
}

// The actual data-crunching for one custom chart. Deliberately independent
// from apiGetDashboardData above (which powers the fixed default widgets) -
// keeping them separate means nothing here can ever risk breaking that
// already-working, more complex default dashboard logic.
function apiGetCustomChartData(p) {
  const sh = ss_().getSheetByName(SHEET.CUSTOM_CHARTS);
  const data = sh.getDataRange().getValues();
  let def = null;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.chartId)) {
      def = {
        chartId: data[i][0], name: data[i][1], type: data[i][2], dataSource: data[i][3],
        dimension: data[i][4], metric: data[i][5], metricField: data[i][6],
        topN: Number(data[i][7]) || 0, sortDir: data[i][8] || 'desc'
      };
      break;
    }
  }
  if (!def) return { ok: false, error: 'Chart not found.' };

  // Every record just carries {dim, val} - val is the raw number for that
  // one row (or 1 when there's nothing numeric to read, e.g. "count of
  // customers"). Sum/Count/Average are all derived from the SAME records
  // at the end, so adding a new metric never means touching this part.
  const records = [];
  const tz = Session.getScriptTimeZone() || 'Etc/UTC';

  if (def.dataSource === 'bills') {
    const billsData = ss_().getSheetByName(SHEET.BILLS).getDataRange().getValues();
    const dimColMap = { BillerName: 13, PaymentMethod: 8, PaymentStatus: 11, CustomerName: 3 };
    const metricColMap = { TotalAmount: 10, TotalQty: 9 };
    for (let i = 1; i < billsData.length; i++) {
      const row = billsData[i];
      if (!row[0]) continue;
      let dimVal;
      if (def.dimension === 'Date') dimVal = Utilities.formatDate(new Date(row[1]), tz, 'yyyy-MM-dd');
      else if (def.dimension === 'Month') dimVal = Utilities.formatDate(new Date(row[1]), tz, 'yyyy-MM');
      else if (def.dimension === 'Year') dimVal = Utilities.formatDate(new Date(row[1]), tz, 'yyyy');
      else dimVal = String(row[dimColMap[def.dimension]] || 'Unknown');
      const rawVal = metricColMap[def.metricField] !== undefined ? (Number(row[metricColMap[def.metricField]]) || 0) : 1;
      records.push({ dim: dimVal, val: rawVal });
    }
  } else if (def.dataSource === 'billitems') {
    const itemsData = ss_().getSheetByName(SHEET.BILL_ITEMS).getDataRange().getValues();
    const metricColMap = { LineTotal: 4, Qty: 3 };
    for (let i = 1; i < itemsData.length; i++) {
      const row = itemsData[i];
      if (!row[0]) continue;
      const dimVal = String(row[1] || 'Unknown'); // ProductName is the only sensible dimension here
      const rawVal = metricColMap[def.metricField] !== undefined ? (Number(row[metricColMap[def.metricField]]) || 0) : 1;
      records.push({ dim: dimVal, val: rawVal });
    }
  } else if (def.dataSource === 'customers') {
    const custData = ss_().getSheetByName(SHEET.CUSTOMERS).getDataRange().getValues();
    for (let i = 1; i < custData.length; i++) {
      if (!custData[i][0]) continue;
      records.push({ dim: 'Customers', val: 1 });
    }
  } else if (def.dataSource === 'products') {
    const prodData = ss_().getSheetByName(SHEET.PRODUCTS).getDataRange().getValues();
    for (let i = 1; i < prodData.length; i++) {
      if (!prodData[i][0]) continue;
      records.push({ dim: 'Products', val: 1 });
    }
  }

  function aggregate_(recs, metric) {
    if (!recs.length) return 0;
    if (metric === 'count') return recs.length;
    const sum = recs.reduce((s, r) => s + r.val, 0);
    if (metric === 'average') return sum / recs.length;
    return sum; // 'sum'
  }

  if (def.type === 'number') {
    return { ok: true, chartId: def.chartId, type: 'number', name: def.name, total: aggregate_(records, def.metric) };
  }

  const groups = {};
  records.forEach(r => { (groups[r.dim] || (groups[r.dim] = [])).push(r); });
  let entries = Object.keys(groups).map(k => ({ label: k, value: aggregate_(groups[k], def.metric) }));
  entries.sort((a, b) => def.sortDir === 'asc' ? a.value - b.value : b.value - a.value);
  if (def.topN > 0) entries = entries.slice(0, def.topN);

  return {
    ok: true, chartId: def.chartId, type: def.type, name: def.name,
    labels: entries.map(e => e.label), values: entries.map(e => e.value)
  };
}

//     so there's nothing here that needs protecting the way editing Tax/Bank
//     details or stock levels does. Nothing in this section ever writes to
//     a sheet.
//     The one exception: DOWNLOADING a report as Excel is gated by the
//     CanAccessReportDownload biller-permission toggle (Super Admin always
//     has it). That toggle only controls whether the Download Excel button
//     appears/works client-side - the file itself is built entirely in the
//     browser from data these same ungated GET endpoints already returned,
//     so there is no separate "download" API action to protect here.
// ---------------------------------------------------------------------------
function fmtDate_(d, pattern, ssRef) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, (ssRef || ss_()).getSpreadsheetTimeZone(), pattern);
}

// A report row cap protects both the Apps Script 6-minute execution limit
// and the browser: it's a "recent operational history" view, not a
// permanent unlimited archive (see REPORT_ROW_CAP note in the setup guide
// re: the ~1 crore rows/sheet ceiling and when to start a fresh year's copy
// of the spreadsheet).
const REPORT_ROW_CAP = 5000;

// ---- Universal Report: one row per PRODUCT LINE SOLD (BillItems level) ---
// This is the single "everything about every sale" report - every bill
// naturally produces as many rows here as it has product lines, so a
// customer who bought 10 products across 3 bills shows up as 10 rows, not
// 3 - the bill-level fields (BillID, PaymentStatus, TotalAmount, etc.)
// simply repeat across that bill's own rows, while ProductName/Qty/
// UnitPrice/LineTotal differ per row. That repetition is expected, not a
// duplicate.
//
// "Customer Name" is read from the BILL's own stored name (Bills sheet),
// not from the Customers master list - the bill is a historical snapshot
// of what the customer was called at sale time, which is what a sales
// report should reflect, and it sidesteps ever depending on the Customers
// sheet being correct for this specific report.
//
// Merges the active spreadsheet with every registered archive, exactly
// like the other reports (see "MULTI-SPREADSHEET CONTINUITY" near ss_()).
// Column names are deliberately unambiguous about which numbers repeat.
// "Qty" and "LineTotal" are unique per row (safe to SUM directly in
// Sheets). "Bill Total Qty" / "Bill Total Amount" are the WHOLE BILL's
// totals, repeated on every product-line row of that same bill - summing
// them directly over-counts by however many product lines each bill had.
// "First Line Of Bill" (TRUE on exactly one row per bill) exists so a
// person can still SUM those bill-level columns correctly by filtering to
// TRUE first. See the summary block written at the top of the sheet by
// buildUniversalReportSheet_() for the numbers already worked out for you.
const UNIVERSAL_REPORT_HEADERS = [
  'CustomerID', 'Customer Name', 'Phone', 'Email', 'BillID', 'BillerID', 'Biller Name',
  'Invoice Date', 'Invoice Time', 'CreatedAt', 'Address', 'DeliveryAddress',
  'ProductName', 'UnitPrice', 'Qty', 'LineTotal', 'PaymentMethod',
  'Bill Total Qty', 'Bill Total Amount',
  'PaymentStatus', 'RazorpayQrId', 'RazorpayPaymentId', 'UpdatedAt', 'UpdatedBy', 'VersionNote',
  'ShowTaxOverride', 'ShowBankOverride', 'First Line Of Bill'
];

function apiGetUniversalReport() {
  const rows = [];
  const seenBillIds = new Set(); // BillIDs are globally unique across every db, so one shared tracker is correct
  allDbs_().forEach(db => {
    const billsSh = db.ss.getSheetByName(SHEET.BILLS);
    const itemsSh = db.ss.getSheetByName(SHEET.BILL_ITEMS);
    if (!billsSh || !itemsSh) return;

    const billsData = billsSh.getDataRange().getValues();
    const billMap = {};
    for (let i = 1; i < billsData.length; i++) {
      const r = billsData[i];
      if (r[0]) billMap[String(r[0])] = r;
    }

    const itemsData = itemsSh.getDataRange().getValues();
    for (let i = 1; i < itemsData.length; i++) {
      const item = itemsData[i];
      if (!item[0]) continue;
      const bill = billMap[String(item[0])];
      if (!bill) continue; // an orphaned line item shouldn't normally happen, but never crash the report over it

      const isFirstLine = !seenBillIds.has(String(item[0]));
      seenBillIds.add(String(item[0]));

      rows.push({
        customerId: bill[2],
        customerName: bill[3],
        phone: bill[4],
        email: bill[5],
        billId: bill[0],
        billerId: bill[12],
        billerName: bill[13],
        invoiceDate: fmtDate_(bill[1], 'yyyy-MM-dd', db.ss),
        invoiceTime: fmtDate_(bill[16], 'HH:mm:ss', db.ss),
        createdAt: fmtDate_(bill[16], 'yyyy-MM-dd HH:mm:ss', db.ss),
        address: bill[6],
        deliveryAddress: bill[7],
        productName: item[1],
        unitPrice: Number(item[2]) || 0,
        qty: Number(item[3]) || 0,
        lineTotal: Number(item[4]) || 0,
        paymentMethod: bill[8],
        totalQty: Number(bill[9]) || 0,
        totalAmount: Number(bill[10]) || 0,
        paymentStatus: bill[11],
        razorpayQrId: bill[14] || '',
        razorpayPaymentId: bill[15] || '',
        updatedAt: fmtDate_(bill[17], 'yyyy-MM-dd HH:mm', db.ss),
        updatedBy: bill[18] || '',
        versionNote: bill[19] || '',
        showTaxOverride: bill[20] || '',
        showBankOverride: bill[21] || '',
        source: db.label,
        isFirstLineOfBill: isFirstLine ? 'TRUE' : 'FALSE'
      });
    }
  });

  rows.sort((a, b) => {
    const ta = a.invoiceDate + ' ' + a.invoiceTime, tb = b.invoiceDate + ' ' + b.invoiceTime;
    return ta < tb ? 1 : ta > tb ? -1 : 0;
  });
  const truncated = rows.length > REPORT_ROW_CAP;
  return { ok: true, rows: rows.slice(0, REPORT_ROW_CAP), truncated: truncated };
}

// Materializes the same join as apiGetUniversalReport() above as an actual
// sheet in the CURRENT (active) spreadsheet - a real, browsable tab for
// anyone who opens the spreadsheet directly, not just the website. Rebuilt
// automatically after every bill save/edit (see apiSaveBill/apiUpdateBill),
// and on-demand via apiRefreshDashboardSheet(). Deliberately only reflects
// THIS spreadsheet's own data (not merged across archives) - it's a mirror
// of what's physically in this spreadsheet, whereas the website's Reports
// menu is what merges active + archives together for you.
function buildUniversalReportSheet_() {
  const ssRef = ss_();
  let sh = ssRef.getSheetByName(SHEET.UNIVERSAL_REPORT);
  if (!sh) sh = ssRef.insertSheet(SHEET.UNIVERSAL_REPORT);
  sh.clear();

  const billsSh = ssRef.getSheetByName(SHEET.BILLS);
  const itemsSh = ssRef.getSheetByName(SHEET.BILL_ITEMS);
  const billsData = billsSh ? billsSh.getDataRange().getValues() : [];
  const billMap = {};
  for (let i = 1; i < billsData.length; i++) {
    const r = billsData[i];
    if (r[0]) billMap[String(r[0])] = r;
  }
  const itemsData = itemsSh ? itemsSh.getDataRange().getValues() : [];

  const dataRows = [];
  const seenBillIds = new Set();
  let totalLineRevenue = 0, totalQtySold = 0;
  for (let i = 1; i < itemsData.length; i++) {
    const item = itemsData[i];
    if (!item[0]) continue;
    const bill = billMap[String(item[0])];
    if (!bill) continue;

    const isFirstLine = !seenBillIds.has(String(item[0]));
    seenBillIds.add(String(item[0]));
    const lineTotal = Number(item[4]) || 0;
    const qty = Number(item[3]) || 0;
    totalLineRevenue += lineTotal;
    totalQtySold += qty;

    dataRows.push([
      bill[2], bill[3], bill[4], bill[5], bill[0], bill[12], bill[13],
      fmtDate_(bill[1], 'yyyy-MM-dd'), fmtDate_(bill[16], 'HH:mm:ss'), fmtDate_(bill[16], 'yyyy-MM-dd HH:mm:ss'),
      bill[6], bill[7],
      item[1], Number(item[2]) || 0, qty, lineTotal,
      bill[8], Number(bill[9]) || 0, Number(bill[10]) || 0,
      bill[11], bill[14] || '', bill[15] || '', fmtDate_(bill[17], 'yyyy-MM-dd HH:mm'), bill[18] || '', bill[19] || '',
      bill[20] || '', bill[21] || '', isFirstLine
    ]);
  }

  const numCols = UNIVERSAL_REPORT_HEADERS.length;

  // --- Rows 1-3: a plain-language summary block with the CORRECT,
  //     already-deduplicated totals, so nobody has to manually select a
  //     column and sum it (and risk summing the wrong one). ---
  sh.getRange(1, 1, 1, numCols).merge();
  sh.getRange(1, 1)
    .setValue('SALES SUMMARY - ' + seenBillIds.size + ' bill(s)  |  Total Sales: ₹' +
      totalLineRevenue.toLocaleString('en-IN') + '  |  Total Qty Sold: ' + totalQtySold)
    .setFontWeight('bold').setFontSize(12).setBackground('#AE2314').setFontColor('#FFFFFF')
    .setHorizontalAlignment('left');

  sh.getRange(2, 1, 1, numCols).merge();
  sh.getRange(2, 1)
    .setValue('⚠ "Bill Total Qty" and "Bill Total Amount" repeat once per product line within the same bill - ' +
      'do NOT sum those two columns directly, they will over-count. "Qty" and "LineTotal" are unique per row and ' +
      'safe to sum. Filter "First Line Of Bill" = TRUE first if you need to sum the two bill-level columns instead.')
    .setFontStyle('italic').setFontSize(9.5).setFontColor('#7A3A12').setBackground('#FDECEA')
    .setWrap(true);
  sh.setRowHeight(2, 34);

  sh.getRange(3, 1, 1, numCols).merge();
  sh.getRange(3, 1).setValue('').setBackground('#FFFFFF'); // thin spacer row

  // --- Row 4: real header row, then data ---
  const HEADER_ROW = 4;
  sh.getRange(HEADER_ROW, 1, 1, numCols).setValues([UNIVERSAL_REPORT_HEADERS]);
  sh.getRange(HEADER_ROW, 1, 1, numCols)
    .setFontWeight('bold').setBackground('#AE2314').setFontColor('#FFFFFF');
  // Belt-and-suspenders: the same warning as an on-hover note directly on
  // the two bill-level header cells, for anyone who scrolls past row 2.
  sh.getRange(HEADER_ROW, 18).setNote('Repeats once per product line on the same bill - do not SUM this column directly. See the summary at the top of this sheet, or filter "First Line Of Bill" = TRUE first.');
  sh.getRange(HEADER_ROW, 19).setNote('Repeats once per product line on the same bill - do not SUM this column directly. See the summary at the top of this sheet, or filter "First Line Of Bill" = TRUE first.');

  if (dataRows.length) {
    sh.getRange(HEADER_ROW + 1, 1, dataRows.length, numCols).setValues(dataRows);
  }
  sh.setFrozenRows(HEADER_ROW);
  try { sh.autoResizeColumns(1, numCols); } catch (e) { /* cosmetic only */ }
}

// ---- Daily Report: one row per (Date, Product) - ONLY when something
// actually happened to that product that day (stock was added, or it was
// sold). A day with no movement for a product simply has no row - nothing
// is synthesized just to fill a calendar grid.
//
// "Added To Stock" comes from StockLog (any positive delta that day, from
// a manual restock or an edit-reversal restoring a previously-sold item).
// "Qty Sold" and "Revenue" come directly from Bills + BillItems, NOT from
// StockLog - this matters because a product doesn't have to be
// stock-tracked to be sold (an untracked product has no StockLog entries
// at all, but obviously still needs to show up here when it sells).
// Merges the active spreadsheet with every registered archive.
function apiGetDailyReport() {
  const map = {}; // "date||productNameLowercase" -> { date, product, addedToStock, qtySold, revenue }

  const getRow = (dateStr, product) => {
    const key = dateStr + '||' + String(product).trim().toLowerCase();
    if (!map[key]) map[key] = { date: dateStr, product: product, addedToStock: 0, qtySold: 0, revenue: 0 };
    return map[key];
  };

  allDbs_().forEach(db => {
    // Stock additions
    const stockSh = db.ss.getSheetByName(SHEET.STOCK_LOG);
    if (stockSh) {
      const stockData = stockSh.getDataRange().getValues();
      for (let i = 1; i < stockData.length; i++) {
        const r = stockData[i];
        if (!r[0]) continue;
        const delta = Number(r[4]) || 0;
        if (delta <= 0) continue; // additions only - sales are handled from Bills below instead
        const dateStr = fmtDate_(r[0], 'yyyy-MM-dd', db.ss);
        getRow(dateStr, r[2]).addedToStock += delta;
      }
    }

    // Sales (covers every product, tracked or not)
    const billsSh = db.ss.getSheetByName(SHEET.BILLS);
    const itemsSh = db.ss.getSheetByName(SHEET.BILL_ITEMS);
    if (billsSh && itemsSh) {
      const billsData = billsSh.getDataRange().getValues();
      const billDateMap = {};
      for (let i = 1; i < billsData.length; i++) {
        const r = billsData[i];
        if (r[0]) billDateMap[String(r[0])] = fmtDate_(r[1], 'yyyy-MM-dd', db.ss);
      }
      const itemsData = itemsSh.getDataRange().getValues();
      for (let i = 1; i < itemsData.length; i++) {
        const item = itemsData[i];
        if (!item[0]) continue;
        const dateStr = billDateMap[String(item[0])];
        if (!dateStr) continue;
        const row = getRow(dateStr, item[1]);
        row.qtySold += Number(item[3]) || 0;
        row.revenue += Number(item[4]) || 0;
      }
    }
  });

  const rows = Object.values(map).sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return String(a.product).localeCompare(String(b.product));
  });
  const truncated = rows.length > REPORT_ROW_CAP;
  return { ok: true, rows: rows.slice(0, REPORT_ROW_CAP), truncated: truncated };
}

const DAILY_REPORT_HEADERS = ['Date', 'Product / Service', 'Added To Stock', 'Qty Sold', 'Revenue That Day'];

// Materializes the same (date, product) join as apiGetDailyReport() above
// as a real sheet in the active spreadsheet - same mirroring principle as
// buildUniversalReportSheet_(): reflects only THIS spreadsheet's own data,
// while the website's Reports menu merges active + archives together.
function buildDailyReportSheet_() {
  const ssRef = ss_();
  let sh = ssRef.getSheetByName(SHEET.DAILY_REPORT);
  if (!sh) sh = ssRef.insertSheet(SHEET.DAILY_REPORT);
  sh.clear();

  const map = {};
  const getRow = (dateStr, product) => {
    const key = dateStr + '||' + String(product).trim().toLowerCase();
    if (!map[key]) map[key] = { date: dateStr, product: product, addedToStock: 0, qtySold: 0, revenue: 0 };
    return map[key];
  };

  const stockSh = ssRef.getSheetByName(SHEET.STOCK_LOG);
  if (stockSh) {
    const stockData = stockSh.getDataRange().getValues();
    for (let i = 1; i < stockData.length; i++) {
      const r = stockData[i];
      if (!r[0]) continue;
      const delta = Number(r[4]) || 0;
      if (delta <= 0) continue;
      getRow(fmtDate_(r[0], 'yyyy-MM-dd'), r[2]).addedToStock += delta;
    }
  }

  const billsSh = ssRef.getSheetByName(SHEET.BILLS);
  const itemsSh = ssRef.getSheetByName(SHEET.BILL_ITEMS);
  if (billsSh && itemsSh) {
    const billsData = billsSh.getDataRange().getValues();
    const billDateMap = {};
    for (let i = 1; i < billsData.length; i++) {
      const r = billsData[i];
      if (r[0]) billDateMap[String(r[0])] = fmtDate_(r[1], 'yyyy-MM-dd');
    }
    const itemsData = itemsSh.getDataRange().getValues();
    for (let i = 1; i < itemsData.length; i++) {
      const item = itemsData[i];
      if (!item[0]) continue;
      const dateStr = billDateMap[String(item[0])];
      if (!dateStr) continue;
      const row = getRow(dateStr, item[1]);
      row.qtySold += Number(item[3]) || 0;
      row.revenue += Number(item[4]) || 0;
    }
  }

  const rows = Object.values(map).sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return String(a.product).localeCompare(String(b.product));
  });

  const out = [DAILY_REPORT_HEADERS].concat(rows.map(r => [r.date, r.product, r.addedToStock, r.qtySold, r.revenue]));
  sh.getRange(1, 1, out.length, DAILY_REPORT_HEADERS.length).setValues(out);
  sh.getRange(1, 1, 1, DAILY_REPORT_HEADERS.length)
    .setFontWeight('bold').setBackground('#AE2314').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
  try { sh.autoResizeColumns(1, DAILY_REPORT_HEADERS.length); } catch (e) { /* cosmetic only */ }
}

// ---- Inventory Log Report: raw audit trail from StockLog -----------------
// Reads the structured PerformerRole/PerformerName/PerformerId columns
// directly - no more regex-parsing a combined text label back apart (that
// approach was fragile, and is exactly what previously caused a Biller's
// own sale to show up with everything dumped into the Name column and
// nothing in the ID column). Also skips zero-delta entries - a save that
// left the stock number exactly where it was isn't a real inventory event.
//
// Merges StockLog across the active spreadsheet and every registered
// archive, same principle as the other reports.
function apiGetInventoryLogReport() {
  const rows = [];
  allDbs_().forEach(db => {
    const sh = db.ss.getSheetByName(SHEET.STOCK_LOG);
    if (!sh) return;
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const r = data[i];
      if (!r[0]) continue;
      const delta = Number(r[4]) || 0;
      if (delta === 0) continue; // no real change happened - not worth a row
      rows.push({
        date: fmtDate_(r[0], 'yyyy-MM-dd', db.ss),
        time: fmtDate_(r[0], 'HH:mm:ss', db.ss),
        billerId: r[10] || '',       // PerformerId - blank unless the actor is an actual Biller
        performedBy: r[9] || r[7],   // PerformerName, falling back to the legacy combined label for any pre-migration row that still slipped through
        role: r[8] || '',
        product: r[2],
        action: r[3],
        change: delta,
        newStock: Number(r[5]) || 0,
        billId: r[6] || '',
        source: db.label
      });
    }
  });
  rows.sort((a, b) => {
    const ta = a.date + ' ' + a.time, tb = b.date + ' ' + b.time;
    return ta < tb ? 1 : ta > tb ? -1 : 0;
  });
  const truncated = rows.length > REPORT_ROW_CAP;
  return { ok: true, rows: rows.slice(0, REPORT_ROW_CAP), truncated: truncated };
}


// Creates every sheet + header row this app needs, on WHATEVER spreadsheet
// is passed in - completely empty, no default data. Used by both
// setupDatabase() below (for the very first spreadsheet, followed by the
// default-data block further down) and by createFreshDatabaseSpreadsheet_()
// (for a brand-new spreadsheet created automatically when the active one
// fills up - see section 0f, "ONE-CLICK AUTOMATIC DATABASE EXPANSION").
// Kept as the single source of truth so the two paths can never drift apart.
function provisionSchemaOnSpreadsheet_(ssRef) {
  createSheetIfMissing_(ssRef, SHEET.SETTINGS, ['Key', 'Value']);
  // Full CURRENT column set written directly - deliberately NOT relying on
  // migrateSchema_ to backfill the rest afterward. A brand-new spreadsheet
  // (whether from setupDatabase() or the automatic "Add New Database"
  // button) marks itself as already caught up to SCHEMA_VERSION the moment
  // it's created, so writing only a partial header set here would leave it
  // permanently short a few columns with no migration ever running to fix it.
  createSheetIfMissing_(ssRef, SHEET.BILLERS, [
    'BillerID', 'Name', 'Password', 'Active', 'CreatedAt',
    'CanAccessTax', 'CanAccessBank', 'CanAccessFindEdit',
    'CanAccessStockView', 'CanAccessStockEdit', 'CanAccessReportDownload',
    'CanAccessDiscount', 'CanAccessDashboard'
  ]);
  createSheetIfMissing_(ssRef, SHEET.CUSTOMERS, ['CustomerID', 'Customer Name', 'Phone', 'Email', 'Address', 'DeliveryAddress', 'CreatedAt']);
  createSheetIfMissing_(ssRef, SHEET.PRODUCTS, ['ProductID', 'ProductName', 'DefaultPrice', 'Active', 'CreatedAt', 'Stock', 'LowStockThreshold']);
  createSheetIfMissing_(ssRef, SHEET.STOCK_LOG, STOCK_LOG_HEADERS);
  createSheetIfMissing_(ssRef, SHEET.BILLS, [
    'BillID', 'Date', 'CustomerID', 'CustomerName', 'Phone', 'Email', 'Address', 'DeliveryAddress',
    'PaymentMethod', 'TotalQty', 'TotalAmount', 'PaymentStatus', 'BillerID', 'BillerName',
    'RazorpayQrId', 'RazorpayPaymentId', 'CreatedAt', 'UpdatedAt', 'UpdatedBy', 'VersionNote',
    'ShowTaxOverride', 'ShowBankOverride', 'DiscountPercent'
  ]);
  createSheetIfMissing_(ssRef, SHEET.BILL_ITEMS, ['BillID', 'ProductName', 'UnitPrice', 'Qty', 'LineTotal', 'DiscountPercent']);
  createSheetIfMissing_(ssRef, SHEET.PAYMENT_LOGS, ['Timestamp', 'BillID', 'Event', 'RazorpayQrId', 'RazorpayPaymentId', 'RawPayload']);
  createSheetIfMissing_(ssRef, SHEET.DASHBOARD, ['This sheet is a placeholder - live charts are rendered on the website. Run buildDashboardSheet() any time to refresh a snapshot here.']);
  createSheetIfMissing_(ssRef, SHEET.UNIVERSAL_REPORT, UNIVERSAL_REPORT_HEADERS);
  createSheetIfMissing_(ssRef, SHEET.DAILY_REPORT, DAILY_REPORT_HEADERS);
  createSheetIfMissing_(ssRef, SHEET.CUSTOM_CHARTS, CUSTOM_CHARTS_HEADERS);
}

// One-time helper: pushes the current THEME_SETTING_DEFAULTS (green/blue)
// straight into the Settings sheet, overwriting whatever theme colors are
// saved there already. Run this ONCE from the Apps Script editor (select
// "forceResetThemeNow" in the function dropdown at the top, then click the
// Run/play button) any time you want the sheet's theme forced back to the
// defaults defined above - no website login needed.
function forceResetThemeNow() {
  THEME_SETTING_DEFAULTS.forEach(pair => setSetting_(pair[0], pair[1]));
}

function setupDatabase() {
  const ssRef = ss_();
  provisionSchemaOnSpreadsheet_(ssRef);

  const settingsSh = ssRef.getSheetByName(SHEET.SETTINGS);
  if (settingsSh.getLastRow() < 2) {
    const defaults = [
      ['CompanyName', 'SJ Physiotherapy'],
      ['Address', '123, Main Street, Coimbatore, Tamil Nadu - 641001'],
      ['Phone', '+91 98765 43210'],
      ['Website', 'www.sjphysiotherapy.in'],
      ['GSTNumber', '33ABCDE1234F1Z5'],
      ['LogoURL', 'https://via.placeholder.com/160x160.png?text=LOGO'],
      ['PrintLogoURL', ''],
      ['CompanyEmail', ''],
      ['CGSTPercent', 0],
      ['SGSTPercent', 0],
      ['BankName', ''],
      ['BankAccountNo', ''],
      ['BankIFSC', ''],
      ['BankAccountHolder', ''],
      ['AuthorizedSignatoryLabel', 'Authorized Signatory'],
      ['ShowCompanyEmail', 'TRUE'],
      ['ShowTaxOnBill', 'TRUE'],
      ['ShowBankDetails', 'TRUE'],
      ['ShowDiscountOption', 'TRUE'],
      ['ShowAuthorizedSignatory', 'TRUE'],
      ['Currency', 'INR'],
      ['SuperAdminUser', 'SJ Physiotherapy'],
      ['SuperAdminPass', 'SJ12345'],
      ['RazorpayKeyId', ''],
      ['RazorpayKeySecret', ''],
      ['WebhookToken', Utilities.getUuid()]
    ].concat(THEME_SETTING_DEFAULTS);
    defaults.forEach(row => settingsSh.appendRow(row));
  }

  const billersSh = ssRef.getSheetByName(SHEET.BILLERS);
  if (billersSh.getLastRow() < 2) {
    billersSh.appendRow(['B001', 'SJ Physiotherapy', 'SJ12345', true, new Date(), true, true, true, true, true, true, true, true]);
  }

  const productsSh = ssRef.getSheetByName(SHEET.PRODUCTS);
  if (productsSh.getLastRow() < 2) {
    // Seeded with a starting stock count + low-stock alert threshold so the
    // new Inventory menu has something meaningful to show immediately.
    [['Idly Batter (1kg)', 60, 40, 10], ['Dosa Batter (1kg)', 65, 40, 10], ['Wet Grinder Service', 300, 10, 2],
     ['Chutney Powder (250g)', 90, 25, 5], ['Rice Flour (1kg)', 55, 30, 5]].forEach(pr => {
      productsSh.appendRow([nextId_(productsSh, 'PROD'), pr[0], pr[1], true, new Date(), pr[2], pr[3]]);
    });
  }

  PropertiesService.getScriptProperties().setProperty('SchemaVersion', String(SCHEMA_VERSION));
  buildUniversalReportSheet_();
  buildDailyReportSheet_();

  SpreadsheetApp.getUi().alert(
    'Setup complete!\n\nYour Webhook Token is:\n' + getSettingsMap_().WebhookToken +
    '\n\nYou will need this to configure the Razorpay webhook URL. See SETUP_GUIDE.md.'
  );
}

function createSheetIfMissing_(ssRef, name, headers) {
  let sh = ssRef.getSheetByName(name);
  if (!sh) {
    sh = ssRef.insertSheet(name);
  }
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#E1341E').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
  }
  return sh;
}




function apiRefreshDashboardSheet(p) {
  const auth = requireSuperAdmin_(p.superAdminUser, p.superAdminPass);
  if (!auth.ok) return auth;
  buildDashboardSheet();
  buildUniversalReportSheet_();
  buildDailyReportSheet_();
  return { ok: true };
}






// ---------------------------------------------------------------------------
// 15. OPTIONAL - populate a live "Dashboard" sheet snapshot with formulas
// ---------------------------------------------------------------------------
function buildDashboardSheet() {
  const ssRef = ss_();
  let sh = ssRef.getSheetByName(SHEET.DASHBOARD);
  if (!sh) sh = ssRef.insertSheet(SHEET.DASHBOARD);
  sh.clear();
  sh.getCharts().forEach(c => sh.removeChart(c));

  const bills = ssRef.getSheetByName(SHEET.BILLS).getDataRange().getValues();
  const items = ssRef.getSheetByName(SHEET.BILL_ITEMS).getDataRange().getValues();

  let totalSalesCount = 0, totalSalesAmount = 0, totalQtySold = 0;
  let cashAmount = 0, upiAmount = 0;
  const customerSet = {};
  for (let i = 1; i < bills.length; i++) {
    const row = bills[i];
    if (!row[0]) continue;
    totalSalesCount++;
    totalSalesAmount += Number(row[10]) || 0;
    if (row[2]) customerSet[row[2]] = true;
    if (String(row[8]) === 'Cash') cashAmount += Number(row[10]) || 0;
    else if (String(row[8]) === 'UPI') upiAmount += Number(row[10]) || 0;
  }
  const uniqueCustomers = Object.keys(customerSet).length;

  const productTotals = {};
  for (let i = 1; i < items.length; i++) {
    const row = items[i];
    if (!row[1]) continue;
    const name = String(row[1]);
    if (!productTotals[name]) productTotals[name] = { qty: 0, amount: 0 };
    productTotals[name].qty += Number(row[3]) || 0;
    productTotals[name].amount += Number(row[4]) || 0;
    totalQtySold += Number(row[3]) || 0;
  }
  const productRows = Object.keys(productTotals)
    .map(name => [name, productTotals[name].qty, productTotals[name].amount])
    .sort((a, b) => b[1] - a[1]);

  // Title
  sh.getRange('A1').setValue('SJ Physiotherapy - SALES DASHBOARD')
    .setFontWeight('bold').setFontSize(15).setFontColor('#AE2314');
  sh.getRange('A1:D1').merge();

  // KPI numbers
  const kpiLabels = ['Total Sales (Bills)', 'Total Sales (Amount)', 'Total Products/Services Sold', 'Unique Customers'];
  const kpiValues = [totalSalesCount, totalSalesAmount, totalQtySold, uniqueCustomers];
  for (let i = 0; i < kpiLabels.length; i++) {
    sh.getRange(3 + i, 1).setValue(kpiLabels[i]).setFontWeight('bold');
    sh.getRange(3 + i, 2).setValue(kpiValues[i]);
  }
  sh.getRange('B3:B6').setBackground('#FCE2DC').setFontWeight('bold').setFontSize(13);

  // Product-wise quantity table
  const prodStartRow = 9;
  sh.getRange(prodStartRow - 1, 1).setValue('Product-wise Quantity Sold').setFontWeight('bold').setFontSize(12);
  sh.getRange(prodStartRow, 1, 1, 3).setValues([['Product/Service', 'Qty Sold', 'Amount (₹)']])
    .setFontWeight('bold').setBackground('#E1341E').setFontColor('#FFFFFF');
  if (productRows.length) {
    sh.getRange(prodStartRow + 1, 1, productRows.length, 3).setValues(productRows);
  }

  // Cash vs UPI table
  const payStartRow = prodStartRow + productRows.length + 4;
  sh.getRange(payStartRow - 1, 1).setValue('Cash vs UPI (Amount Received)').setFontWeight('bold').setFontSize(12);
  sh.getRange(payStartRow, 1, 1, 2).setValues([['Method', 'Amount (₹)']])
    .setFontWeight('bold').setBackground('#E1341E').setFontColor('#FFFFFF');
  sh.getRange(payStartRow + 1, 1, 2, 2).setValues([
    ['Cash', cashAmount],
    ['UPI', upiAmount]
  ]);

  sh.autoResizeColumns(1, 3);

  // Charts
  if (productRows.length) {
    const barChart = sh.newChart()
      .setChartType(Charts.ChartType.COLUMN)
      .addRange(sh.getRange(prodStartRow, 1, productRows.length + 1, 2))
      .setPosition(3, 5, 0, 0)
      .setOption('title', 'Product-wise Quantity Sold')
      .setOption('colors', ['#E1341E'])
      .setOption('legend', { position: 'none' })
      .setOption('width', 480)
      .setOption('height', 300)
      .build();
    sh.insertChart(barChart);
  }

  const pieChart = sh.newChart()
    .setChartType(Charts.ChartType.PIE)
    .addRange(sh.getRange(payStartRow, 1, 3, 2))
    .setPosition(20, 5, 0, 0)
    .setOption('title', 'Cash vs UPI (Amount Received)')
    .setOption('colors', ['#FF914D', '#E1341E'])
    .setOption('width', 480)
    .setOption('height', 300)
    .build();
  sh.insertChart(pieChart);
}