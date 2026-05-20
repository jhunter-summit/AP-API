// main file for Express server and API endpoints

require('dotenv').config();

const express = require('express');
const sql = require('mssql');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.set('trust proxy', true);
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const elapsedMs = Date.now() - start;

    writeLog('api.log', 'REQUEST', {
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      elapsedMs,
      ip: req.ip,
      userAgent: req.get('user-agent') || null
    });
  });

  next();
});

const port = process.env.PORT || 3000;

const fs = require('fs');
const path = require('path');

const config = {
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: false,
    trustServerCertificate: true
  }
};

let pool;

console.log({
  server: config.server,
  database: config.database,
  user: config.user,
  port: config.port,
  passwordLength: config.password?.length
});

const logDir = path.join(__dirname, 'logs');

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

function writeLog(fileName, message, data = null) {
  const timestamp = new Date().toISOString();
  const logPath = path.join(logDir, fileName);

  let line = `[${timestamp}] ${message}`;

  if (data !== null && data !== undefined) {
    line += ` ${JSON.stringify(data)}`;
  }

  line += '\n';

  fs.appendFile(logPath, line, err => {
    if (err) {
      console.error('Failed to write log:', err);
    }
  });
}

function validateQuadientInvoice(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object') {
    return ['Payload must be a JSON object'];
  }

  if (!payload.invoiceNumber) {
    errors.push('invoiceNumber is required');
  }

  if (payload.vendorKey == null && !payload.vendorId) {
    errors.push('Either vendorKey or vendorId is required');
  }

  if (!payload.invoiceDate) {
    errors.push('invoiceDate is required');
  }

  if (!payload.dueDate) {
    errors.push('dueDate is required');
  }

  if (payload.totalAmount == null) {
    errors.push('totalAmount is required');
  }

  if (!Array.isArray(payload.lines) || payload.lines.length === 0) {
    errors.push('lines must be a non-empty array');
  }

  if (Array.isArray(payload.lines)) {
    payload.lines.forEach((line, index) => {
      if (line.lineAmount == null) {
        errors.push(`lines[${index}].lineAmount is required`);
      }

      if (line.quantity == null) {
        errors.push(`lines[${index}].quantity is required`);
      }

      if (line.unitCost == null) {
        errors.push(`lines[${index}].unitCost is required`);
      }

      if (line.rcvrLineKey == null) {
        errors.push(`lines[${index}].rcvrLineKey is required`);
      }

      if (line.poLineKey == null) {
        errors.push(`lines[${index}].poLineKey is required`);
      }

      if (line.glAccountKey == null) {
        errors.push(`lines[${index}].glAccountKey is required`);
      }
    });
  }

  const lineTotal = Array.isArray(payload.lines)
    ? payload.lines.reduce((sum, line) => sum + Number(line.lineAmount || 0), 0)
    : 0;

  const totalAmount = Number(payload.totalAmount || 0);

  if (Array.isArray(payload.lines) && Math.abs(lineTotal - totalAmount) > 0.01) {
    errors.push(`Line total ${lineTotal.toFixed(2)} does not match totalAmount ${totalAmount.toFixed(2)}`);
  }

  return errors;
}

async function initDb() {
    pool = await sql.connect(config);
    console.log('Connected to SQL Server');
}

app.get('/health', (req, res) => {
    res.json({ status: 'OK' });
});

const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');

const swaggerDocument = YAML.load('./swagger/openapi.yaml');

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

function apiKeyAuth(req, res, next) {
  // console.log('--- API KEY AUTH START ---');
  // console.log('REQUIRE_API_KEY:', process.env.REQUIRE_API_KEY);

  if (process.env.REQUIRE_API_KEY !== 'true') {
    console.log('API key not required. Continuing.');
    return next();
  }

    const providedKey = String(
    req.get('x-api-key') ||
    req.header('x-api-key') ||
    req.query.apiKey ||
    req.query.api_key ||
    ''
    ).trim();

//   console.log('Provided key exists:', !!providedKey);
//   console.log('Expected key exists:', !!process.env.API_KEY);
//   console.log('Keys match:', providedKey === process.env.API_KEY);

  if (!providedKey || providedKey !== process.env.API_KEY) {
    console.log('AUTH FAILED - returning 401 from apiKeyAuth');
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid API key'
    });
  }

  //console.log('AUTH PASSED - calling next()');
  return next();
}
app.use(apiKeyAuth);

function cleanString(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length === 0 ? null : text;
}

app.get('/db-test', async (req, res) => {
    try {
        const result = await pool.request().query(`
            SELECT 
                DB_NAME() AS CurrentDB,
                SYSTEM_USER AS LoginUser,
                GETDATE() AS ServerTime
        `);

        res.json(result.recordset[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/companies', async (req, res) => {
    try {
        const result = await pool.request().query(`
            SELECT *
            FROM dbo.tciCompany
        `);

        res.json(result.recordset);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(port, async () => {
    try {
        await initDb();
        console.log(`Server running on http://localhost:${port}`);
    } catch (err) {
        console.error('DB connection failed:', err);
    }
});

app.get('/vendors', async (req, res) => {
  try {
    const { page, pageSize, offset } = getPaging(req.query);
    const updatedSince = req.query.updatedSince || null;

    const request = pool.request()
      .input('updatedSince', sql.DateTime, updatedSince)
      .input('offset', sql.Int, offset)
      .input('pageSize', sql.Int, pageSize);

    const result = await request.query(`
      SELECT
          VendKey AS vendorKey,
          LTRIM(RTRIM(VendID)) AS vendorId,
          LTRIM(RTRIM(VendName)) AS vendorName,
          LTRIM(RTRIM(CompanyID)) AS companyId,
          UpdateDate AS updatedAt
      FROM dbo.tapVendor
      WHERE
          (@updatedSince IS NULL OR UpdateDate >= @updatedSince)
      ORDER BY VendName, VendID
      OFFSET @offset ROWS
      FETCH NEXT @pageSize ROWS ONLY;
    `);

    res.json({
      page,
      pageSize,
      count: result.recordset.length,
      data: result.recordset
    });
  } catch (err) {
    console.error('Vendors query failed:', err);

    res.status(500).json({
      error: 'QUERY_FAILED',
      message: err.message
    });
  }
});

app.get('/invoices', async (req, res) => {
  try {
    const {
      updatedSince = null,
      page = 1,
      pageSize = 100
    } = req.query;

    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safePageSize = Math.min(Math.max(parseInt(pageSize, 10) || 100, 1), 500);
    const offset = (safePage - 1) * safePageSize;

    const request = pool.request()
      .input('updatedSince', updatedSince)
      .input('offset', offset)
      .input('pageSize', safePageSize);

    const result = await request.query(`
      SELECT
        inv.VoucherKey AS voucherKey,
        LTRIM(RTRIM(inv.CompanyID)) AS companyId,
        LTRIM(RTRIM(inv.TranID)) AS invoiceNumber,
        inv.TranDate AS invoiceDate,
        inv.PostDate AS postDate,
        inv.InvcRcptDate AS invoiceReceiptDate,
        inv.DueDate AS dueDate,
        inv.TranAmt AS invoiceAmount,
        inv.PurchAmt AS purchaseAmount,
        inv.Balance AS balance,
        inv.Status AS statusCode,
        CASE inv.Status
            WHEN 2 THEN 'Open'
            WHEN 1 THEN 'Closed'
            ELSE 'Unknown'
        END AS status,
        LTRIM(RTRIM(inv.TranCmnt)) AS invoiceDescription,
        inv.CreateDate AS createdAt,
        inv.UpdateDate AS updatedAt,
        inv.VendKey AS vendKey,
        LTRIM(RTRIM(v.VendID)) AS vendorId,
        LTRIM(RTRIM(v.VendName)) AS vendorName
      FROM dbo.tapVoucher inv
      INNER JOIN dbo.tapVendor v
        ON inv.VendKey = v.VendKey
      WHERE
        inv.Balance <> 0
        AND (@updatedSince IS NULL OR inv.UpdateDate >= @updatedSince)
      ORDER BY inv.UpdateDate DESC
      OFFSET @offset ROWS
      FETCH NEXT @pageSize ROWS ONLY;
    `);

    res.json({
      data: result.recordset,
      pagination: {
        page: safePage,
        pageSize: safePageSize
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'QUERY_FAILED',
      message: err.message
    });
  }
});

app.get('/invoices-with-lines', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '100', 10), 1), 500);
    const offset = (page - 1) * pageSize;

    const updatedSince = req.query.updatedSince || null;

    if (updatedSince && Number.isNaN(Date.parse(updatedSince))) {
      return res.status(400).json({
        error: 'VALIDATION_FAILED',
        message: 'updatedSince must be a valid date or date-time value'
      });
    }

    // ============================
    // STEP 1: Page invoice headers
    // ============================
    const headerRequest = pool.request()
      .input('updatedSince', sql.DateTime, updatedSince)
      .input('offset', sql.Int, offset)
      .input('pageSize', sql.Int, pageSize);

    const headerResult = await headerRequest.query(`
      SELECT
        inv.VoucherKey AS voucherKey,
        LTRIM(RTRIM(inv.CompanyID)) AS companyId,
        LTRIM(RTRIM(inv.TranID)) AS invoiceNumber,
        inv.TranDate AS invoiceDate,
        inv.PostDate AS postDate,
        inv.InvcRcptDate AS invoiceReceiptDate,
        inv.DueDate AS dueDate,
        inv.TranAmt AS invoiceAmount,
        inv.PurchAmt AS purchaseAmount,
        inv.Balance AS balance,
        inv.Status AS statusCode,
        CASE inv.Status
            WHEN 2 THEN 'Open'
            WHEN 1 THEN 'Closed'
            ELSE 'Unknown'
        END AS status,
        LTRIM(RTRIM(inv.TranCmnt)) AS invoiceDescription,
        inv.CreateDate AS createdAt,
        inv.UpdateDate AS updatedAt,
        inv.VendKey AS vendKey,
        LTRIM(RTRIM(v.VendID)) AS vendorId,
        LTRIM(RTRIM(v.VendName)) AS vendorName
      FROM dbo.tapVoucher inv
      INNER JOIN dbo.tapVendor v
          ON inv.VendKey = v.VendKey
      WHERE
          inv.Balance <> 0
          AND (@updatedSince IS NULL OR inv.UpdateDate >= @updatedSince)
      ORDER BY inv.UpdateDate DESC, inv.VoucherKey
      OFFSET @offset ROWS
      FETCH NEXT @pageSize ROWS ONLY;
    `);

    const invoices = headerResult.recordset;

    if (invoices.length === 0) {
      return res.json({
        page,
        pageSize,
        count: 0,
        data: []
      });
    }

    // ============================
    // STEP 2: Fetch lines for those invoices
    // ============================
    const voucherKeys = invoices.map(inv => inv.voucherKey);

    const lineRequest = pool.request();

    const voucherKeyParams = voucherKeys.map((voucherKey, index) => {
      const paramName = `voucherKey${index}`;
      lineRequest.input(paramName, sql.Int, voucherKey);
      return `@${paramName}`;
    });

    const lineResult = await lineRequest.query(`
      SELECT
          d.VoucherKey AS voucherKey,
          d.VoucherLineKey AS voucherLineKey,
          d.SeqNo AS lineNumber,
          d.POLineKey AS poLineKey,
          d.RcvrLineKey AS rcvrLineKey,
          d.ItemKey AS itemKey,
          LTRIM(RTRIM(d.Description)) AS description,
          LTRIM(RTRIM(d.ExtCmnt)) AS extendedComment,
          d.UnitCost AS unitCost,
          d.UnitCostExact AS unitCostExact,
          d.UnitMeasKey AS unitMeasKey,
          d.ExtAmt AS lineAmount,
          d.STaxClassKey AS sTaxClassKey,
          d.MatchStatus AS matchStatus,
          d.ReturnType AS returnType,
          LTRIM(RTRIM(d.TargetCompanyID)) AS targetCompanyId,

          po.POKey AS poKey,
          LTRIM(RTRIM(po.TranID)) AS poNumber,

          rl.RcvrKey AS receiptKey,
          LTRIM(RTRIM(r.TranID)) AS receiptNumber,
          r.TranDate AS receiptDate,

          pold.QtyOrd AS quantityOrdered,
          pold.QtyRcvd AS quantityReceived,
          pold.QtyInvcd AS quantityInvoiced,
          pold.QtyOpenToRcv AS quantityOpenToReceive,
          pold.QtyRtrnCredit AS quantityReturnedForCredit,
          pold.QtyRtrnReplacement AS quantityReturnedForReplacement,
          pold.GLAcctKey AS glAccountKey,

          LTRIM(RTRIM(gl.GLAcctNo)) AS glAccountNumber,
          LTRIM(RTRIM(gl.Description)) AS glAccountDescription,

          CASE
              WHEN d.UnitCost IS NOT NULL AND d.UnitCost <> 0 THEN d.ExtAmt / d.UnitCost
              ELSE NULL
          END AS calculatedInvoiceQuantity

      FROM dbo.tapVoucherDetl d

      LEFT JOIN dbo.tpoPOLine pol
          ON pol.POLineKey = d.POLineKey

      LEFT JOIN dbo.tpoPurchOrder po
          ON po.POKey = pol.POKey

      LEFT JOIN dbo.tpoRcvrLine rl
          ON rl.RcvrLineKey = d.RcvrLineKey

      LEFT JOIN dbo.tpoReceiver r
          ON r.RcvrKey = rl.RcvrKey

      LEFT JOIN dbo.tpoPOLineDist pold
          ON pold.POLineKey = d.POLineKey

      LEFT JOIN dbo.tglAccount gl
          ON gl.GLAcctKey = pold.GLAcctKey

      WHERE d.VoucherKey IN (${voucherKeyParams.join(', ')})
      ORDER BY d.VoucherKey, d.SeqNo, d.VoucherLineKey;
    `);

    // ============================
    // STEP 3: Group lines by VoucherKey
    // ============================
    const linesByVoucherKey = new Map();

    for (const line of lineResult.recordset) {
      if (!linesByVoucherKey.has(line.voucherKey)) {
        linesByVoucherKey.set(line.voucherKey, []);
      }

      const { voucherKey, ...lineData } = line;
      linesByVoucherKey.get(voucherKey).push(lineData);
    }

    const data = invoices.map(inv => ({
      ...inv,
      lines: linesByVoucherKey.get(inv.voucherKey) || []
    }));

    return res.json({
      page,
      pageSize,
      count: data.length,
      data
    });

  } catch (err) {
    console.error('Invoices with lines query failed:', err);

    return res.status(500).json({
      error: 'QUERY_FAILED',
      message: err.message
    });
  }
});

app.get('/invoice-lines', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '100', 10), 1), 500);
    const offset = (page - 1) * pageSize;

    const updatedSince = req.query.updatedSince || null;
    const voucherKey = req.query.voucherKey ? parseInt(req.query.voucherKey, 10) : null;
    const invoiceNumber = req.query.invoiceNumber || null;

    if (req.query.voucherKey && Number.isNaN(voucherKey)) {
      return res.status(400).json({
        error: 'VALIDATION_FAILED',
        message: 'voucherKey must be a valid integer'
      });
    }

    const request = pool.request()
      .input('updatedSince', updatedSince)
      .input('voucherKey', voucherKey)
      .input('invoiceNumber', invoiceNumber)
      .input('offset', offset)
      .input('pageSize', pageSize);

    const result = await request.query(`
      SELECT
          d.VoucherKey AS voucherKey,
          LTRIM(RTRIM(inv.TranID)) AS invoiceNumber,
          inv.TranDate AS invoiceDate,
          inv.DueDate AS dueDate,
          LTRIM(RTRIM(inv.CompanyID)) AS companyId,

          inv.VendKey AS vendKey,
          LTRIM(RTRIM(v.VendID)) AS vendorId,
          LTRIM(RTRIM(v.VendName)) AS vendorName,

          d.VoucherLineKey AS voucherLineKey,
          d.SeqNo AS lineNumber,
          d.POLineKey AS poLineKey,
          d.RcvrLineKey AS rcvrLineKey,
          d.ItemKey AS itemKey,
          LTRIM(RTRIM(d.Description)) AS description,
          LTRIM(RTRIM(d.ExtCmnt)) AS extendedComment,
          d.UnitCost AS unitCost,
          d.UnitCostExact AS unitCostExact,
          d.UnitMeasKey AS unitMeasKey,
          d.ExtAmt AS lineAmount,
          d.STaxClassKey AS sTaxClassKey,
          d.MatchStatus AS matchStatus,
          d.ReturnType AS returnType,
          LTRIM(RTRIM(d.TargetCompanyID)) AS targetCompanyId,

          pold.QtyOrd AS quantityOrdered,
          pold.QtyRcvd AS quantityReceived,
          pold.QtyInvcd AS quantityInvoiced,
          pold.QtyOpenToRcv AS quantityOpenToReceive,
          pold.QtyRtrnCredit AS quantityReturnedForCredit,
          pold.QtyRtrnReplacement AS quantityReturnedForReplacement,
          pold.GLAcctKey AS glAccountKey,
          LTRIM(RTRIM(gl.GLAcctNo)) AS glAccountNumber,
          LTRIM(RTRIM(gl.Description)) AS glAccountDescription,

          CASE
              WHEN d.UnitCost IS NOT NULL AND d.UnitCost <> 0 THEN d.ExtAmt / d.UnitCost
              ELSE NULL
          END AS calculatedInvoiceQuantity

      FROM dbo.tapVoucherDetl d
        INNER JOIN dbo.tapVoucher inv
            ON d.VoucherKey = inv.VoucherKey
        INNER JOIN dbo.tapVendor v
            ON inv.VendKey = v.VendKey
        LEFT JOIN dbo.tpoPOLineDist pold
            ON pold.POLineKey = d.POLineKey
        LEFT JOIN dbo.tglAccount gl
            ON gl.GLAcctKey = pold.GLAcctKey
      

      WHERE
          inv.Balance <> 0
          AND (@updatedSince IS NULL OR inv.UpdateDate >= @updatedSince)
          AND (@voucherKey IS NULL OR d.VoucherKey = @voucherKey)
          AND (@invoiceNumber IS NULL OR inv.TranID = @invoiceNumber)

      ORDER BY inv.UpdateDate DESC, d.VoucherKey, d.SeqNo, d.VoucherLineKey

      OFFSET @offset ROWS
      FETCH NEXT @pageSize ROWS ONLY;
    `);

    return res.json({
      page,
      pageSize,
      count: result.recordset.length,
      data: result.recordset
    });

  } catch (err) {
    console.error('Invoice lines query failed:', err);

    return res.status(500).json({
      error: 'QUERY_FAILED',
      message: err.message
    });
  }
});

app.get('/gl-accounts', async (req, res) => {
  try {
    const requestedPageSize = parseInt(req.query.pageSize || '500', 10);
    console.log('Requested pageSize:', requestedPageSize);
    const pageSize = Math.min(Math.max(requestedPageSize || 500, 1), 1000);

    let offset;

    if (req.query.offset !== undefined) {
      offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    } else {
      const page = Math.max(parseInt(req.query.page || '1', 10), 1);
      offset = (page - 1) * pageSize;
    }

    const page = Math.floor(offset / pageSize) + 1;

    const startRow = offset + 1;
    const endRow = offset + pageSize;

    const updatedSince = req.query.updatedSince || null;

    const request = pool.request()
      .input('updatedSince', sql.DateTime, updatedSince)
      .input('startRow', sql.Int, startRow)
      .input('endRow', sql.Int, endRow);

    const result = await request.query(`
      WITH CurrentActiveAccounts AS (
          SELECT
              ga.GLAcctKey,
              ga.CompanyID,
              ga.GLAcctNo,
              ga.Description,
              ga.Status,
              ga.UpdateDate
          FROM dbo.tglAccount ga
          WHERE
              ga.Status = 1
              AND NOT EXISTS (
                  SELECT 1
                  FROM dbo.tglAccount newer
                  WHERE
                      newer.CompanyID = ga.CompanyID
                      AND newer.GLAcctNo = ga.GLAcctNo
                      AND (
                          newer.UpdateDate > ga.UpdateDate
                          OR (
                              newer.UpdateDate = ga.UpdateDate
                              AND newer.GLAcctKey > ga.GLAcctKey
                          )
                      )
              )
              AND (@updatedSince IS NULL OR ga.UpdateDate >= @updatedSince)
      ),
      NumberedAccounts AS (
          SELECT
              ROW_NUMBER() OVER (
                  ORDER BY CompanyID, GLAcctNo, GLAcctKey
              ) AS rowNum,
              COUNT(*) OVER () AS totalCount,
              GLAcctKey,
              CompanyID,
              GLAcctNo,
              Description,
              Status,
              UpdateDate
          FROM CurrentActiveAccounts
      )
      SELECT
          GLAcctKey AS glAccountKey,
          LTRIM(RTRIM(CompanyID)) AS companyId,
          LTRIM(RTRIM(GLAcctNo)) AS glAccountNumber,
          LTRIM(RTRIM(Description)) AS glAccountDescription,
          Status AS status,
          UpdateDate AS updatedAt,
          totalCount
      FROM NumberedAccounts
      WHERE rowNum BETWEEN @startRow AND @endRow
      ORDER BY rowNum;
    `);

    const totalCount = result.recordset.length > 0
      ? result.recordset[0].totalCount
      : 0;

    const data = result.recordset.map(row => {
      const { totalCount, ...account } = row;
      return account;
    });

    return res.json({
      page,
      pageSize,
      count: data.length,
      totalCount,
      totalPages: Math.ceil(totalCount / pageSize),
      data
    });

  } catch (err) {
    console.error('GL accounts query failed:', err);

    return res.status(500).json({
      error: 'QUERY_FAILED',
      message: err.message
    });
  }
});

app.get('/purchase-orders', async (req, res) => {
  try {
    const { updatedSince = null } = req.query;
    const { page, pageSize, offset } = getPaging(req.query);

    const request = pool.request()
      .input('updatedSince', updatedSince);

    const headerRequest = pool.request()
      .input('updatedSince', updatedSince)
      .input('offset', offset)
      .input('pageSize', pageSize);

    const headerResult = await headerRequest.query(`
      SELECT
          po.POKey AS poKey,
          po.VendKey AS vendKey,
          po.TranID AS poNumber,
          po.TranDate AS poDate,
          po.CompanyID AS companyId,
          v.VendID AS vendorId,
          v.VendName AS vendorName
      FROM dbo.tpoPurchOrder po
      INNER JOIN dbo.tapVendor v
          ON po.VendKey = v.VendKey
      WHERE
          (@updatedSince IS NULL OR po.TranDate >= @updatedSince)
      ORDER BY po.TranDate DESC, po.TranID, po.POKey
      OFFSET @offset ROWS
      FETCH NEXT @pageSize ROWS ONLY;
    `);

    const purchaseOrders = headerResult.recordset;

    if (purchaseOrders.length === 0) {
      return res.json({
        page,
        pageSize,
        count: 0,
        data: []
      });
    }

    const poKeys = purchaseOrders.map(po => po.poKey);

    const lineRequest = pool.request();

    const poKeyParams = poKeys.map((poKey, index) => {
      const paramName = `poKey${index}`;
      lineRequest.input(paramName, poKey);
      return `@${paramName}`;
    });

    const lineResult = await lineRequest.query(`
      SELECT
          pol.POKey AS poKey,
          pol.POLineKey AS poLineKey,
          pol.POLineNo AS poLineNumber,
          pol.ItemKey AS itemKey,
          pol.Description AS lineDescription,
          pol.UnitCost AS unitCost,
          pol.ExtAmt AS lineAmount,
          CASE
              WHEN pol.UnitCost <> 0 THEN pol.ExtAmt / pol.UnitCost
              ELSE NULL
          END AS quantityOrdered
      FROM dbo.tpoPOLine pol
      WHERE pol.POKey IN (${poKeyParams.join(', ')})
      ORDER BY pol.POKey, pol.POLineNo;
    `);

    const linesByPoKey = new Map();

    for (const line of lineResult.recordset) {
      if (!linesByPoKey.has(line.poKey)) {
        linesByPoKey.set(line.poKey, []);
      }

      const { poKey, ...lineData } = line;
      linesByPoKey.get(poKey).push(lineData);
    }

    const data = purchaseOrders.map(po => ({
      ...po,
      lines: linesByPoKey.get(po.poKey) || []
    }));

    return res.json({
      page,
      pageSize,
      count: data.length,
      data
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'QUERY_FAILED',
      message: err.message
    });
  }
});

app.get('/receipts', async (req, res) => {
  try {
    const { updatedSince = null } = req.query;
    const { page, pageSize, offset } = getPaging(req.query);

    const request = pool.request()
      .input('updatedSince', updatedSince)
      .input('offset', sql.Int, offset)
      .input('pageSize', sql.Int, pageSize);
    const result = await request.query(`
      SELECT
        rcv.RcvrKey AS receiptKey,
        rcv.TranID AS receiptNumber,
        rcv.TranDate AS receiptDate,
        rcv.CompanyID AS companyId,

        v.VendID AS vendorId,
        v.VendName AS vendorName,

        line.RcvrLineKey AS receiptLineKey,
        line.SeqNo AS receiptLineNumber,
        line.POLineKey AS poLineKey,
        line.UnitCost AS unitCost,
        line.TaxAmt AS taxAmount,

        po.TranID AS poNumber,
        pol.POLineNo AS poLineNumber,
        pol.ItemKey AS itemKey,
        pol.Description AS lineDescription

      FROM dbo.tpoReceiver rcv
      INNER JOIN dbo.tpoRcvrLine line
        ON rcv.RcvrKey = line.RcvrKey
      INNER JOIN dbo.tapVendor v
        ON rcv.VendKey = v.VendKey

      LEFT JOIN dbo.tpoPOLine pol
        ON line.POLineKey = pol.POLineKey
      LEFT JOIN dbo.tpoPurchOrder po
        ON pol.POKey = po.POKey

      WHERE
        (@updatedSince IS NULL OR rcv.TranDate >= @updatedSince)

      ORDER BY rcv.TranDate DESC, rcv.TranID, line.SeqNo

      OFFSET @offset ROWS
      FETCH NEXT @pageSize ROWS ONLY;
    `);

    res.json({
      data: result.recordset,
      pagination: { page, pageSize }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'QUERY_FAILED',
      message: err.message
    });
  }
});

app.get('/customers', async (req, res) => {
  try {
    const { page, pageSize, offset } = getPaging(req.query);
    const updatedSince = req.query.updatedSince || null;

    const request = pool.request()
      .input('updatedSince', sql.DateTime, updatedSince)
      .input('offset', sql.Int, offset)
      .input('pageSize', sql.Int, pageSize);

    const result = await request.query(`
      SELECT
          CustKey AS customerKey,
          LTRIM(RTRIM(REPLACE(REPLACE(CustID, CHAR(13), ''), CHAR(10), ''))) AS customerId,
          LTRIM(RTRIM(REPLACE(REPLACE(CustName, CHAR(13), ' '), CHAR(10), ' '))) AS customerName,
          LTRIM(RTRIM(CompanyID)) AS companyId,
          UpdateDate AS updatedAt
      FROM dbo.tarCustomer
      WHERE
          (@updatedSince IS NULL OR UpdateDate >= @updatedSince)
      ORDER BY CustName, CustID
      OFFSET @offset ROWS
      FETCH NEXT @pageSize ROWS ONLY;
    `);

    res.json({
      page,
      pageSize,
      count: result.recordset.length,
      data: result.recordset
    });

  } catch (err) {
    console.error('Customers query failed:', err);

    res.status(500).json({
      error: 'QUERY_FAILED',
      message: err.message
    });
  }
});

app.get('/statements', async (req, res) => {
  try {
    const { updatedSince = null, customerId = null } = req.query;
    const { page, pageSize, offset } = getPaging(req.query);

    const request = pool.request()
      .input('offset', sql.Int, offset)
      .input('pageSize', sql.Int, pageSize)
      .input('updatedSince', updatedSince)
      .input('customerId', customerId);

    const result = await request.query(`
      SELECT
        c.CustKey AS customerKey,
        c.CustID AS customerId,
        c.CustName AS customerName,

        inv.InvcKey AS invoiceKey,
        inv.TranID AS invoiceNumber,
        inv.TranDate AS invoiceDate,
        inv.DueDate AS dueDate,
        inv.TranAmt AS invoiceAmount,
        inv.Balance AS balance,
        inv.Status AS statusCode,
        inv.UpdateDate AS updatedAt

      FROM dbo.tarInvoice inv
      INNER JOIN dbo.tarCustomer c
        ON inv.CustKey = c.CustKey

      WHERE
        inv.Balance <> 0
        AND (@updatedSince IS NULL OR inv.UpdateDate >= @updatedSince)
        AND (@customerId IS NULL OR c.CustID = @customerId)

      ORDER BY c.CustID, inv.TranDate DESC

      OFFSET @offset ROWS
      FETCH NEXT @pageSize ROWS ONLY;
    `);

    res.json({
      data: result.recordset,
      pagination: { page, pageSize }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'QUERY_FAILED',
      message: err.message
    });
  }
});

app.post('/quadient/invoice', async (req, res) => {
  const payload = req.body;

  writeLog('quadient-invoice.log', 'INVOICE_POST_RECEIVED', {
    invoiceNumber: payload?.invoiceNumber || null,
    vendorKey: payload?.vendorKey || null,
    vendorId: payload?.vendorId || null,
    companyId: payload?.companyId || null,
    totalAmount: payload?.totalAmount || null,
    lineCount: Array.isArray(payload?.lines) ? payload.lines.length : null,
    payload
  });

  try {
    const validationErrors = validateQuadientInvoice(payload);

    if (validationErrors.length > 0) {
      writeLog('quadient-invoice.log', 'INVOICE_VALIDATION_FAILED', {
        invoiceNumber: payload?.invoiceNumber || null,
        errors: validationErrors,
        payload
      });
      return res.status(400).json({
        error: 'VALIDATION_FAILED',
        message: 'Invoice payload failed validation',
        details: validationErrors
      });
    }

    const transaction = new sql.Transaction(pool);

    await transaction.begin();

    try {
      const headerRequest = new sql.Request(transaction);

      const headerResult = await headerRequest
        .input('invoiceNumber', sql.NVarChar(50), cleanString(payload.invoiceNumber))
        .input('vendKey', sql.Int, payload.vendorKey ?? null)
        .input('vendorId', sql.NVarChar(50), cleanString(payload.vendorId))
        .input('companyId', sql.NVarChar(20), cleanString(payload.companyId))
        .input('invoiceDate', sql.Date, payload.invoiceDate)
        .input('dueDate', sql.Date, payload.dueDate)
        .input('memo', sql.NVarChar(sql.MAX), cleanString(payload.memo))
        .input('beanworksInvoiceUrl', sql.NVarChar(500), cleanString(payload.beanworksInvoiceUrl))
        .input('currency', sql.NVarChar(10), cleanString(payload.currency))
        .input('totalAmount', sql.Decimal(19, 4), payload.totalAmount)
        .input('rawPayload', sql.NVarChar(sql.MAX), JSON.stringify(payload))
        .query(`
          INSERT INTO dbo.QuadientInvoiceStaging (
              InvoiceNumber,
              VendKey,
              VendorID,
              CompanyID,
              InvoiceDate,
              DueDate,
              Memo,
              BeanworksInvoiceURL,
              Currency,
              TotalAmount,
              RawPayload,
              ProcessingStatus
          )
          OUTPUT INSERTED.QuadientInvoiceStagingID AS stagingId
          VALUES (
              @invoiceNumber,
              @vendKey,
              @vendorId,
              @companyId,
              @invoiceDate,
              @dueDate,
              @memo,
              @beanworksInvoiceUrl,
              @currency,
              @totalAmount,
              @rawPayload,
              'ReadyForDIM'
          );
        `);

      const stagingId = headerResult.recordset[0].stagingId;

      for (const line of payload.lines) {
        const lineRequest = new sql.Request(transaction);

        await lineRequest
          .input('stagingId', sql.Int, stagingId)
          .input('lineNumber', sql.Int, line.lineNumber ?? null)
          .input('itemKey', sql.Int, line.itemKey ?? null)
          .input('itemId', sql.NVarChar(100), cleanString(line.itemId))
          .input('unitCost', sql.Decimal(19, 4), line.unitCost)
          .input('quantity', sql.Decimal(19, 4), line.quantity)
          .input('unitMeasure', sql.NVarChar(20), cleanString(line.unitMeasure))
          //.input('unitMeasKey', sql.Int, line.unitMeasKey ?? null)
          .input('lineAmount', sql.Decimal(19, 4), line.lineAmount)
          .input('poKey', sql.Int, line.poKey ?? null)
          .input('poNumber', sql.NVarChar(50), cleanString(line.poNumber))
          .input('poLineKey', sql.Int, line.poLineKey)
          .input('poLineNumber', sql.Int, line.poLineNumber ?? null)
          .input('rcvrLineKey', sql.Int, line.rcvrLineKey)
          .input('description', sql.NVarChar(sql.MAX), cleanString(line.description))
          .input('sTaxClassKey', sql.Int, line.sTaxClassKey ?? null)
          .input('department', sql.NVarChar(50), cleanString(line.department))
          .input('costCenter', sql.NVarChar(50), cleanString(line.costCenter))
          .input('glAccountKey', sql.Int, line.glAccountKey ?? null)
          .input('quantityOrdered', sql.Decimal(19, 4), line.quantityOrdered ?? null)
          .input('quantityReceived', sql.Decimal(19, 4), line.quantityReceived ?? null)
          .input('quantityInvoiced', sql.Decimal(19, 4), line.quantityInvoiced ?? null)
          .input('quantityOpenToReceive', sql.Decimal(19, 4), line.quantityOpenToReceive ?? null)
          .input('quantityReturnedForCredit', sql.Decimal(19, 4), line.quantityReturnedForCredit ?? null)
          .input('quantityReturnedForReplacement', sql.Decimal(19, 4), line.quantityReturnedForReplacement ?? null)
          .query(`
            INSERT INTO dbo.QuadientInvoiceLineStaging (
                QuadientInvoiceStagingID,
                LineNumber,
                ItemKey,
                ItemID,
                UnitCost,
                Quantity,
                UnitMeasure,
                LineAmount,
                POKey,
                PONumber,
                POLineKey,
                POLineNumber,
                RcvrLineKey,
                Description,
                STaxClassKey,
                Department,
                CostCenter,
                GLAcctKey,
                QuantityOrdered,
                QuantityReceived,
                QuantityInvoiced,
                QuantityOpenToReceive,
                QuantityReturnedForCredit,
                QuantityReturnedForReplacement
            )
            VALUES (
                @stagingId,
                @lineNumber,
                @itemKey,
                @itemId,
                @unitCost,
                @quantity,
                @unitMeasure,
                @lineAmount,
                @poKey,
                @poNumber,
                @poLineKey,
                @poLineNumber,
                @rcvrLineKey,
                @description,
                @sTaxClassKey,
                @department,
                @costCenter,
                @glAccountKey,
                @quantityOrdered,
                @quantityReceived,
                @quantityInvoiced,
                @quantityOpenToReceive,
                @quantityReturnedForCredit,
                @quantityReturnedForReplacement
            );
          `);
      }

      await transaction.commit();

      writeLog('quadient-invoice.log', 'INVOICE_STAGED', {
        stagingId,
        invoiceNumber: payload.invoiceNumber,
        vendorKey: payload.vendorKey ?? null,
        vendorId: payload.vendorId || null,
        lineCount: payload.lines.length
      });

      return res.status(201).json({
        status: 'received',
        processingStatus: 'ReadyForDIM',
        stagingId,
        invoiceNumber: payload.invoiceNumber,
        vendorKey: payload.vendorKey ?? null,
        vendorId: payload.vendorId || null,
        lineCount: payload.lines.length
      });

    } catch (err) {

      writeLog('quadient-invoice.log', 'INVOICE_RECEIVE_FAILED', {
        message: err.message,
        stack: err.stack,
        invoiceNumber: payload?.invoiceNumber || null,
        vendorKey: payload?.vendorKey || null,
        vendorId: payload?.vendorId || null
      });

      console.error('Quadient invoice receive failed:', err);

      await transaction.rollback();
      throw err;
    }

  } catch (err) {
    console.error('Quadient invoice receive failed:', err);

    return res.status(500).json({
      error: 'INVOICE_RECEIVE_FAILED',
      message: err.message
    });
  }
});

function getPaging(query) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 100, 1), 500);
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset };
}