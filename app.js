// main file for Express server and API endpoints

require('dotenv').config();

const express = require('express');
const sql = require('mssql');

const app = express();
app.use(express.json({ limit: '2mb' }));

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

const port = process.env.PORT || 443;

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
  console.log('--- API KEY AUTH START ---');
  console.log('REQUIRE_API_KEY:', process.env.REQUIRE_API_KEY);

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
            SELECT TOP 10 *
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
    const result = await pool.request().query(`
      SELECT TOP 50
        VendID AS vendorId,
        VendKey AS vendorKey,
        VendName AS vendorName
      FROM dbo.tapVendor
      ORDER BY VendName
    `);

    res.json({
      data: result.recordset
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
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
        inv.CompanyID AS companyId,
        inv.TranID AS invoiceNumber,
        inv.TranDate AS invoiceDate,
        inv.PostDate AS postDate,
        inv.InvcRcptDate AS invoiceReceiptDate,
        inv.DueDate AS dueDate,
        inv.TranAmt AS invoiceAmount,
        inv.PurchAmt AS purchaseAmount,
        inv.Balance AS balance,
        inv.Status AS statusCode,
        CASE inv.Status
            WHEN 1 THEN 'Open'
            WHEN 2 THEN 'Closed'
            ELSE 'Unknown'
        END AS status,
        inv.TranCmnt AS invoiceDescription,
        inv.CreateDate AS createdAt,
        inv.UpdateDate AS updatedAt,
        v.VendID AS vendorId,
        v.VendName AS vendorName
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

app.get('/gl-accounts', async (req, res) => {
  try {
    const result = await pool.request().query(`
      SELECT
        GLAcctNo AS accountNumber,
        Description AS description,
        CASE WHEN Status = 1 THEN 1 ELSE 0 END AS active
      FROM dbo.tglAccount
      ORDER BY GLAcctNo
    `);

    res.json({ data: result.recordset });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'QUERY_FAILED', message: err.message });
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
      .input('updatedSince', updatedSince);

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

      OFFSET ${offset} ROWS
      FETCH NEXT ${pageSize} ROWS ONLY;
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
    const result = await pool.request().query(`
      SELECT
        CustID AS customerId,
        CustName AS customerName,
        CompanyID AS companyId
      FROM dbo.tarCustomer
      ORDER BY CustName
    `);

    res.json({ data: result.recordset });

  } catch (err) {
    console.error(err);
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

      OFFSET ${offset} ROWS
      FETCH NEXT ${pageSize} ROWS ONLY;
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
        .input('invoiceNumber', sql.NVarChar(50), payload.invoiceNumber)
        .input('vendKey', sql.Int, payload.vendorKey ?? null)
        .input('vendorId', sql.NVarChar(50), payload.vendorId || null)
        .input('companyId', sql.NVarChar(20), payload.companyId || null)
        .input('invoiceDate', sql.Date, payload.invoiceDate)
        .input('dueDate', sql.Date, payload.dueDate)
        .input('memo', sql.NVarChar(sql.MAX), payload.memo || null)
        .input('beanworksInvoiceUrl', sql.NVarChar(500), payload.beanworksInvoiceUrl || null)
        .input('currency', sql.NVarChar(10), payload.currency || null)
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
          .input('itemId', sql.NVarChar(100), line.itemId || null)
          .input('unitCost', sql.Decimal(19, 4), line.unitCost)
          .input('quantity', sql.Decimal(19, 4), line.quantity)
          .input('unitMeasure', sql.NVarChar(20), line.unitMeasure || null)
          .input('unitMeasKey', sql.Int, line.unitMeasKey ?? null)
          .input('lineAmount', sql.Decimal(19, 4), line.lineAmount)
          .input('poKey', sql.Int, line.poKey ?? null)
          .input('poNumber', sql.NVarChar(50), line.poNumber || null)
          .input('poLineKey', sql.Int, line.poLineKey)
          .input('poLineNumber', sql.Int, line.poLineNumber ?? null)
          .input('rcvrLineKey', sql.Int, line.rcvrLineKey)
          .input('description', sql.NVarChar(sql.MAX), line.description || null)
          .input('sTaxClassKey', sql.Int, line.sTaxClassKey ?? null)
          .input('department', sql.NVarChar(50), line.department || null)
          .input('costCenter', sql.NVarChar(50), line.costCenter || null)
          .query(`
            INSERT INTO dbo.QuadientInvoiceLineStaging (
                QuadientInvoiceStagingID,
                LineNumber,
                ItemKey,
                ItemID,
                UnitCost,
                Quantity,
                UnitMeasure,
                UnitMeasKey,
                LineAmount,
                POKey,
                PONumber,
                POLineKey,
                POLineNumber,
                RcvrLineKey,
                Description,
                STaxClassKey,
                Department,
                CostCenter
            )
            VALUES (
                @stagingId,
                @lineNumber,
                @itemKey,
                @itemId,
                @unitCost,
                @quantity,
                @unitMeasure,
                @unitMeasKey,
                @lineAmount,
                @poKey,
                @poNumber,
                @poLineKey,
                @poLineNumber,
                @rcvrLineKey,
                @description,
                @sTaxClassKey,
                @department,
                @costCenter
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