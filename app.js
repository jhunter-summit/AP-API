// main file for Express server and API endpoints

require('dotenv').config();

const express = require('express');
const sql = require('mssql');

const app = express();
const port = process.env.PORT || 3000;

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



function getPaging(query) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 100, 1), 500);
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset };
}