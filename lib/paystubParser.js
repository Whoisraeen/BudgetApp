const { PDFParse } = require('pdf-parse');

// Parse a paystub PDF buffer into one or more paystub records.
// Designed primarily for AT&T HR Access format, but uses generic regex
// patterns that work on most US payroll exports.
async function parsePaystubPDF(buffer) {
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  // Concatenate all pages — many providers split one stub across 2 pages.
  const fullText = result.pages.map(p => p.text).join('\n');
  return parsePaystubText(fullText);
}

function parsePaystubText(fullText) {
  // Split into chunks at each "CHECK DATE:" boundary.
  // Each chunk = one paystub. First chunk before any CHECK DATE is the header (ignored).
  const chunks = [];
  const re = /CHECK DATE:/g;
  const matches = [...fullText.matchAll(re)];
  if (matches.length === 0) return [];

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : fullText.length;
    chunks.push(fullText.substring(start, end));
  }

  const stubs = [];
  for (const chunk of chunks) {
    const stub = parseOneStub(chunk);
    if (stub) stubs.push(stub);
  }
  return stubs;
}

function num(s) {
  if (!s) return 0;
  return parseFloat(String(s).replace(/,/g, '')) || 0;
}

function toISODate(mdyy) {
  // "12/12/2025" -> "2025-12-12"
  const m = mdyy.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function findLine(text, label) {
  // Match a labeled line followed by 1-3 numbers (this period / YTD)
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s+([\\d,]+\\.\\d{2})(?:\\s+([\\d,]+\\.\\d{2}))?(?:\\s+([\\d,]+\\.\\d{2}))?`);
  const m = text.match(re);
  if (!m) return null;
  return { current: num(m[1]), ytd: num(m[2]) };
}

function parseOneStub(text) {
  // Required: check date
  const cd = text.match(/CHECK DATE:\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
  if (!cd) return null;
  const check_date = toISODate(cd[1]);

  // Pay period
  const pp = text.match(/PAY PERIOD:\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
  const pay_period_start = pp ? toISODate(pp[1]) : null;
  const pay_period_end   = pp ? toISODate(pp[2]) : null;

  // CURRENT row: gross / tax / deductions / net
  let gross = 0, tax_total = 0, deduction_total = 0, net = 0;
  const cur = text.match(/CURRENT\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/);
  if (cur) {
    gross = num(cur[1]);
    tax_total = num(cur[2]);
    deduction_total = num(cur[3]);
    net = num(cur[4]);
  }

  // YTD row (last column 'net' may be "xxxxxx" — leave as null then)
  let ytd_gross = 0, ytd_tax = 0, ytd_deductions = 0, ytd_net = 0;
  const ytd = text.match(/YTD\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})(?:\s+([\d,]+\.\d{2}|x+))?/);
  if (ytd) {
    ytd_gross = num(ytd[1]);
    ytd_tax = num(ytd[2]);
    ytd_deductions = num(ytd[3]);
    ytd_net = ytd[4] && /^[\d,]+\.\d{2}$/.test(ytd[4]) ? num(ytd[4]) : (ytd_gross - ytd_tax - ytd_deductions);
  }

  // Tax components
  const oasdi      = findLine(text, 'OASDI')?.current || 0;
  const medicare   = findLine(text, 'Medicare')?.current || 0;
  const federal    = findLine(text, 'Federal Withholding')?.current || 0;
  // State tax label varies: "State Tax - MO" or "State Withholding"
  const stateMatch = text.match(/State Tax\s*-\s*(\w+)\s+([\d,]+\.\d{2})/);
  const state_tax  = stateMatch ? num(stateMatch[2]) : (findLine(text, 'State Tax')?.current || 0);
  const state      = stateMatch ? stateMatch[1] : null;
  const cityMatch  = text.match(/City Tax\s*-\s*(\w+)\s+([\d,]+\.\d{2})/);
  const city_tax   = cityMatch ? num(cityMatch[2]) : 0;
  const city       = cityMatch ? cityMatch[1] : null;

  // Deduction line items (everything in the DEDUCTIONS section)
  // We grab lines that look like: "<LABEL> <num.num> <num.num>"
  const deductions = {};
  const knownDeductionLabels = [
    'MEDICAL-PRETX', 'DENTAL-PRETX', 'VISION-PRETX', 'CAREPLUS-PRETX',
    'UNION DUES CWA', 'CWA-COPE PAC', '401K', 'ROTH 401K', 'HSA', 'FSA',
    'LIFE INSURANCE', 'AD&D', 'LTD', 'STD'
  ];
  for (const label of knownDeductionLabels) {
    const f = findLine(text, label);
    if (f && (f.current > 0 || f.ytd > 0)) {
      deductions[label] = { current: f.current, ytd: f.ytd };
    }
  }

  // Hours worked / rate
  const hoursMatch = text.match(/REGULAR\s+([\d.]+)\s+([\d:]+)/);
  let hours_worked = null, rate = null;
  if (hoursMatch) {
    rate = num(hoursMatch[1]);
    const [h, m] = hoursMatch[2].split(':').map(Number);
    hours_worked = h + (m || 0) / 60;
  }

  // Employer
  const empMatch = text.match(/((?:AT&T|[A-Z][A-Z& ]{5,40}LLC|[A-Z][A-Z& ]{5,40}INC)[\w &.,-]*)/);
  const employer = empMatch ? empMatch[1].trim().slice(0, 80) : null;

  return {
    check_date,
    pay_period_start,
    pay_period_end,
    gross,
    net,
    tax_total,
    deduction_total,
    oasdi,
    medicare,
    federal,
    state_tax,
    city_tax,
    ytd_gross,
    ytd_net,
    ytd_tax,
    ytd_deductions,
    deductions_json: JSON.stringify(deductions),
    hours_worked,
    rate,
    employer,
    state,
    city,
    raw_text: text.slice(0, 4000),
  };
}

module.exports = { parsePaystubPDF, parsePaystubText };
