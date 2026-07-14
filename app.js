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
const crypto = require('crypto');

const SAGE_DIM_TRAN_TYPE_ID = process.env.SAGE_DIM_TRAN_TYPE_ID || 'IN';
const SAGE_DIM_PO_MATCH_STATUS = Number(process.env.SAGE_DIM_PO_MATCH_STATUS || 2);
const ENABLE_DIM_TEST_ENDPOINT = process.env.ENABLE_DIM_TEST_ENDPOINT === 'true';

let pool;

const nodemailer = require('nodemailer');

function createMailTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: process.env.SMTP_USER
      ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      : undefined
  });
}

async function sendEmail({ to, subject, text }) {
  const transporter = createMailTransporter();

  return transporter.sendMail({
    from: process.env.AP_IMPORT_FAILURE_EMAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text
  });
}

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

  const invoiceType = normalizeInvoiceType(payload.invoiceType || 'PO_MATCHED');
  const validInvoiceTypes = ['PO_MATCHED', 'TWO_WAY'];

  if (!validInvoiceTypes.includes(invoiceType)) {
    errors.push(`invoiceType must be one of: ${validInvoiceTypes.join(', ')}`);
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
      const lineType = normalizeInvoiceLineType(line);
      const validLineTypes = ['PO_MATCHED', 'ADDITIONAL_CHARGE'];

      if (!validLineTypes.includes(lineType)) {
        errors.push(`lines[${index}].lineType must be one of: ${validLineTypes.join(', ')}`);
      }

      if (line.lineAmount == null) {
        errors.push(`lines[${index}].lineAmount is required`);
      }

      if (line.glAccountKey == null) {
        errors.push(`lines[${index}].glAccountKey is required`);
      }

      if (invoiceType === 'PO_MATCHED') {
        if (lineType === 'PO_MATCHED') {
          if (line.quantity == null) {
            errors.push(`lines[${index}].quantity is required for PO_MATCHED invoice lines`);
          }

          if (line.unitCost == null) {
            errors.push(`lines[${index}].unitCost is required for PO_MATCHED invoice lines`);
          }

          if (line.rcvrLineKey == null) {
            errors.push(`lines[${index}].rcvrLineKey is required for PO_MATCHED invoice lines`);
          }

          if (line.poLineKey == null) {
            errors.push(`lines[${index}].poLineKey is required for PO_MATCHED invoice lines`);
          }
        }

        if (lineType === 'ADDITIONAL_CHARGE') {
          if (!line.description) {
            errors.push(`lines[${index}].description is required for ADDITIONAL_CHARGE lines`);
          }
        }
      }

      if (invoiceType === 'TWO_WAY') {
        if (!line.description) {
          errors.push(`lines[${index}].description is required for TWO_WAY invoices`);
        }
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

async function pushQuadientInvoiceToSageDim({ stagingId, invoiceNumber }) {
  writeLog('quadient-invoice.log', 'PUSH_DIM_FUNCTION_ENTERED', {
    args: arguments.length,
    stagingId: stagingId || null,
    invoiceNumber: invoiceNumber || null
  });
  if (!stagingId && !invoiceNumber) {
    const err = new Error('Either stagingId or invoiceNumber is required');
    err.statusCode = 400;
    throw err;
  }

  const sessionKey = crypto.randomInt(1, 2147483647);
  const tranTypeId = SAGE_DIM_TRAN_TYPE_ID;
  const poMatchedStatus = SAGE_DIM_PO_MATCH_STATUS;

  const transaction = new sql.Transaction(pool);

  await transaction.begin();

  try {
    // Resolve the Quadient staging row first.
    const findRequest = new sql.Request(transaction);

    let findResult;

    if (stagingId) {
      findResult = await findRequest
        .input('stagingId', sql.Int, stagingId)
        .query(`
          SELECT TOP 1
              QuadientInvoiceStagingID,
              InvoiceNumber,
              ProcessingStatus
          FROM dbo.QuadientInvoiceStaging
          WHERE QuadientInvoiceStagingID = @stagingId;
        `);
    } else {
      findResult = await findRequest
        .input('invoiceNumber', sql.NVarChar(50), cleanString(invoiceNumber))
        .query(`
          SELECT TOP 1
              QuadientInvoiceStagingID,
              InvoiceNumber,
              ProcessingStatus
          FROM dbo.QuadientInvoiceStaging
          WHERE InvoiceNumber = @invoiceNumber
          ORDER BY QuadientInvoiceStagingID DESC;
        `);
    }

    if (findResult.recordset.length === 0) {
      const err = new Error('Quadient invoice staging record was not found');
      err.statusCode = 404;
      throw err;
    }

    const invoice = findResult.recordset[0];
    const resolvedStagingId = invoice.QuadientInvoiceStagingID;
    const tranNo = String(invoice.InvoiceNumber || '').substring(0, 15);

    if (!tranNo) {
      const err = new Error('InvoiceNumber is required to create Sage DIM TranNo');
      err.statusCode = 400;
      throw err;
    }

    if (invoice.ProcessingStatus === 'PushedToSageStaging') {
      const err = new Error(`Invoice staging record ${resolvedStagingId} has already been pushed to Sage staging`);
      err.statusCode = 409;
      throw err;
    }

    // Header insert: QuadientInvoiceStaging -> StgPendVoucher
    const headerRequest = new sql.Request(transaction);

    const headerResult = await headerRequest
      .input('stagingId', sql.Int, resolvedStagingId)
      .input('sessionKey', sql.Int, sessionKey)
      .input('tranNo', sql.VarChar(15), tranNo)
      .input('tranTypeId', sql.VarChar(2), tranTypeId)
      .query(`
        INSERT INTO dbo.StgPendVoucher (
            CurrID,
            DueDate,
            InvcRcptDate,
            PostDate,
            PurchAmt,
            TranAmt,
            TranAmtHC,
            TranCmnt,
            TranDate,
            TranNo,
            TranTypeID,
            VendID,
            ProcessStatus,
            SessionKey
        )
        OUTPUT INSERTED.RowKey AS pendVoucherRowKey
        SELECT
            LEFT(ISNULL(h.Currency, 'USD'), 3) AS CurrID,
            h.DueDate,
            h.InvoiceDate AS InvcRcptDate,
            h.InvoiceDate AS PostDate,
            CAST(ROUND(h.TotalAmount, 2) AS DECIMAL(15, 2)) AS PurchAmt,
            CAST(ROUND(h.TotalAmount, 2) AS DECIMAL(15, 2)) AS TranAmt,
            CAST(ROUND(h.TotalAmount, 2) AS DECIMAL(15, 2)) AS TranAmtHC,
            LEFT(ISNULL(h.Memo, ''), 50) AS TranCmnt,
            h.InvoiceDate AS TranDate,
            @tranNo AS TranNo,
            @tranTypeId AS TranTypeID,
            LEFT(h.VendorID, 12) AS VendID,
            0 AS ProcessStatus,
            @sessionKey AS SessionKey
        FROM dbo.QuadientInvoiceStaging h
        WHERE h.QuadientInvoiceStagingID = @stagingId;
      `);

    if (headerResult.recordset.length === 0) {
      const err = new Error('Failed to insert Sage DIM voucher header');
      err.statusCode = 500;
      throw err;
    }

    const pendVoucherRowKey = headerResult.recordset[0].pendVoucherRowKey;

    // Detail insert: QuadientInvoiceLineStaging -> StgVoucherDetl
    const lineRequest = new sql.Request(transaction);

    const lineResult = await lineRequest
      .input('stagingId', sql.Int, resolvedStagingId)
      .input('sessionKey', sql.Int, sessionKey)
      .input('tranNo', sql.VarChar(15), tranNo)
      .input('tranTypeId', sql.VarChar(2), tranTypeId)
      .input('poMatchedStatus', sql.Int, SAGE_DIM_PO_MATCH_STATUS)
      .query(`
        INSERT INTO dbo.StgVoucherDetl (
            Description,
            ExtAmt,
            ExtCmnt,
            GLAcctNo,
            ItemID,
            MatchStatus,
            PONo,
            POLineNo,
            Quantity,
            SeqNo,
            TargetCompanyID,
            TranNo,
            TranTypeID,
            UnitCost,
            UnitMeasID,
            ProcessStatus,
            STaxSchdID,
            STaxClassID,
            SessionKey
        )
        OUTPUT INSERTED.RowKey AS voucherDetailRowKey
        SELECT
            LEFT(ISNULL(l.Description, ''), 40) AS Description,

            CAST(
                ROUND(
                    ISNULL(l.LineAmount, ISNULL(l.UnitCost, 0) * ISNULL(NULLIF(l.Quantity, 0), 1)),
                    2
                ) AS DECIMAL(15, 2)
            ) AS ExtAmt,

            LEFT(ISNULL(l.Description, ''), 255) AS ExtCmnt,

            LEFT(
                REPLACE(
                    COALESCE(l.GLAccountNumber, gl.GLAcctNo),
                    '-',
                    ''
                ),
                100
            ) AS GLAcctNo,

            LEFT(l.ItemID, 30) AS ItemID,

            CASE
                WHEN l.LineType = 'PO_MATCHED' THEN 2
                ELSE 1
            END AS MatchStatus,

            LEFT(l.PONumber, 10) AS PONo,
            l.POLineNumber AS POLineNo,

            CAST(
                ROUND(
                    CASE
                        WHEN l.Quantity IS NULL OR l.Quantity = 0 THEN 1
                        ELSE l.Quantity
                    END,
                    8
                ) AS DECIMAL(16, 8)
            ) AS Quantity,

            ISNULL(l.LineNumber, 1) AS SeqNo,

            LEFT(h.CompanyID, 3) AS TargetCompanyID,
            @tranNo AS TranNo,
            @tranTypeId AS TranTypeID,

            CAST(
                ROUND(
                    CASE
                        WHEN l.UnitCost IS NULL THEN l.LineAmount
                        ELSE l.UnitCost
                    END,
                    2
                ) AS DECIMAL(15, 2)
            ) AS UnitCost,

            LEFT(l.UnitMeasure, 6) AS UnitMeasID,

            0 AS ProcessStatus,
            '001' AS STaxSchdID,
            'Nontaxable' AS STaxClassID,
            @sessionKey AS SessionKey
        FROM dbo.QuadientInvoiceLineStaging l
        INNER JOIN dbo.QuadientInvoiceStaging h
            ON h.QuadientInvoiceStagingID = l.QuadientInvoiceStagingID
        LEFT JOIN dbo.tglAccount gl
            ON gl.GLAcctKey = l.GLAcctKey
        WHERE h.QuadientInvoiceStagingID = @stagingId;
      `);

    const detailCount = lineResult.recordset.length;

    if (detailCount === 0) {
      const err = new Error('No invoice lines were inserted into Sage DIM staging');
      err.statusCode = 400;
      throw err;
    }

    // Mark your historical staging row as pushed.
    const updateRequest = new sql.Request(transaction);

    await updateRequest
      .input('stagingId', sql.Int, resolvedStagingId)
      .input('sessionKey', sql.Int, sessionKey)
      .input('tranNo', sql.VarChar(15), tranNo)
      .input('tranTypeId', sql.VarChar(2), tranTypeId)
      .input('message', sql.NVarChar(sql.MAX), `Pushed to Sage DIM staging. SessionKey=${sessionKey}; TranNo=${tranNo}; TranTypeID=${tranTypeId}; HeaderRowKey=${pendVoucherRowKey}; DetailRows=${detailCount}`)
      .query(`
        UPDATE dbo.QuadientInvoiceStaging
        SET
            ProcessingStatus = 'PushedToSageStaging',
            ProcessingMessage = @message,
            ProcessedAt = GETDATE()
        WHERE QuadientInvoiceStagingID = @stagingId;
      `);

    await transaction.commit();

    return {
      stagingId: resolvedStagingId,
      invoiceNumber: invoice.InvoiceNumber,
      tranNo,
      tranTypeId,
      sessionKey,
      pendVoucherRowKey,
      detailCount,
      processingStatus: 'PushedToSageStaging'
    };

  } catch (err) {
    try {
      await transaction.rollback();
    } catch (rollbackErr) {
      console.error('Sage DIM push rollback failed:', rollbackErr);
    }

    throw err;
  }
}

async function initDb() {
    pool = await sql.connect(config);
    console.log('Connected to SQL Server');
}

app.post('/quadient/invoice/push-to-dim-test', async (req, res) => {
  if (!ENABLE_DIM_TEST_ENDPOINT) {
    return res.status(404).json({
      error: 'NOT_FOUND',
      message: 'DIM test endpoint is disabled'
    });
  }

  try {
    const stagingId = req.body.stagingId ?? null;
    const invoiceNumber = req.body.invoiceNumber ?? null;

    const result = await pushQuadientInvoiceToSageDim({
      stagingId,
      invoiceNumber
    });

    return res.status(200).json({
      status: 'pushed',
      ...result
    });

  } catch (err) {
    console.error('DIM test push failed:', err);

    return res.status(err.statusCode || 500).json({
      error: 'DIM_PUSH_FAILED',
      message: err.message
    });
  }
});

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

function normalizeInvoiceType(value) {
  const text = cleanString(value || 'PO_MATCHED');

  if (!text) return 'PO_MATCHED';

  const normalized = text
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

  if (normalized === 'TWO_WAY' || normalized === '2_WAY' || normalized === 'NON_PO') {
    return 'TWO_WAY';
  }

  if (normalized === 'PO_MATCHED' || normalized === 'THREE_WAY' || normalized === '3_WAY') {
    return 'PO_MATCHED';
  }

  return normalized;
}

function normalizeInvoiceLineType(line) {
  const explicitType = cleanString(line.lineType);

  if (explicitType) {
    const normalized = explicitType
      .toUpperCase()
      .replace(/[\s-]+/g, '_');

    if (
      normalized === 'PO_MATCHED' ||
      normalized === 'PO' ||
      normalized === 'RECEIPT_MATCHED' ||
      normalized === 'RECEIVER_MATCHED'
    ) {
      return 'PO_MATCHED';
    }

    if (
      normalized === 'ADDITIONAL_CHARGE' ||
      normalized === 'NON_PO' ||
      normalized === 'FREIGHT' ||
      normalized === 'PACKAGING' ||
      normalized === 'MISC' ||
      normalized === 'MISC_CHARGE'
    ) {
      return 'ADDITIONAL_CHARGE';
    }

    return normalized;
  }

  if (line.poLineKey != null || line.rcvrLineKey != null) {
    return 'PO_MATCHED';
  }

  return 'ADDITIONAL_CHARGE';
}

function normalizeInvoiceType(value) {
  const text = cleanString(value || 'PO_MATCHED');

  if (!text) return 'PO_MATCHED';

  const normalized = text
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

  if (normalized === 'TWO_WAY' || normalized === '2_WAY' || normalized === 'NON_PO') {
    return 'TWO_WAY';
  }

  if (normalized === 'PO_MATCHED' || normalized === 'THREE_WAY' || normalized === '3_WAY') {
    return 'PO_MATCHED';
  }

  return normalized;
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
      SELECT
          LTRIM(RTRIM(CompanyID)) AS companyId,
          LTRIM(RTRIM(CompanyName)) AS companyName
      FROM dbo.tsmCompany
      ORDER BY CompanyID;
    `);

    res.json({
      page: 1,
      pageSize: result.recordset.length,
      count: result.recordset.length,
      data: result.recordset
    });
  } catch (err) {
    console.error('Companies query failed:', err);

    res.status(500).json({
      error: 'QUERY_FAILED',
      message: err.message
    });
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
    console.log('Requested pageSize:', requestedPageSize);app.get('/companies', async (req, res) => {
  try {
    const result = await pool.request().query(`
      SELECT
          LTRIM(RTRIM(CompanyID)) AS companyId,
          LTRIM(RTRIM(CompanyName)) AS companyName
      FROM dbo.tsmCompany
      ORDER BY CompanyID;
    `);

    res.json({
      page: 1,
      pageSize: result.recordset.length,
      count: result.recordset.length,
      data: result.recordset
    });
  } catch (err) {
    console.error('Companies query failed:', err);

    res.status(500).json({
      error: 'QUERY_FAILED',
      message: err.message
    });
  }
});
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
          LTRIM(RTRIM(pol.Description)) AS lineDescription,
          pol.UnitCost AS unitCost,
          pol.ExtAmt AS lineAmount,

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
              WHEN pol.UnitCost IS NOT NULL AND pol.UnitCost <> 0 THEN pol.ExtAmt / pol.UnitCost
              ELSE NULL
          END AS calculatedQuantityOrdered

      FROM dbo.tpoPOLine pol

      LEFT JOIN dbo.tpoPOLineDist pold
          ON pold.POLineKey = pol.POLineKey

      LEFT JOIN dbo.tglAccount gl
          ON gl.GLAcctKey = pold.GLAcctKey

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
        LTRIM(RTRIM(rcv.TranID)) AS receiptNumber,
        rcv.TranDate AS receiptDate,
        LTRIM(RTRIM(rcv.CompanyID)) AS companyId,

        LTRIM(RTRIM(v.VendID)) AS vendorId,
        LTRIM(RTRIM(v.VendName)) AS vendorName,

        line.RcvrLineKey AS receiptLineKey,
        line.SeqNo AS receiptLineNumber,
        line.POLineKey AS poLineKey,
        line.UnitCost AS unitCost,
        line.TaxAmt AS taxAmount,

        LTRIM(RTRIM(po.TranID)) AS poNumber,
        pol.POLineNo AS poLineNumber,
        pol.ItemKey AS itemKey,
        LTRIM(RTRIM(pol.Description)) AS lineDescription,

        pold.QtyOrd AS quantityOrdered,
        pold.QtyRcvd AS quantityReceived,
        pold.QtyInvcd AS quantityInvoiced,
        pold.QtyOpenToRcv AS quantityOpenToReceive,
        pold.QtyRtrnCredit AS quantityReturnedForCredit,
        pold.QtyRtrnReplacement AS quantityReturnedForReplacement,
        pold.GLAcctKey AS glAccountKey

      FROM dbo.tpoReceiver rcv
      INNER JOIN dbo.tpoRcvrLine line
        ON rcv.RcvrKey = line.RcvrKey
      INNER JOIN dbo.tapVendor v
        ON rcv.VendKey = v.VendKey
      LEFT JOIN dbo.tpoPOLine pol
        ON line.POLineKey = pol.POLineKey
      LEFT JOIN dbo.tpoPurchOrder po
        ON pol.POKey = po.POKey
      LEFT JOIN dbo.tpoPOLineDist pold
        ON pold.POLineKey = line.POLineKey

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

async function runSagePendingApImport(pool, { companyId, tranNo, vendId }) {
  const request = pool.request();

  request.input('CompanyID', sql.VarChar(3), companyId);
  request.input('TranNo', sql.VarChar(30), tranNo);
  request.input('VendID', sql.VarChar(12), vendId);
  request.input('UserID', sql.VarChar(5), 'admin');

  request.output('SessionKey', sql.Int);
  request.output('ResultCode', sql.Int);
  request.output('ResultMessage', sql.VarChar(4000));

  const result = await request.execute('dbo.spQuadient_RunPendingAPVoucherImport');

  return {
    sessionKey: result.output.SessionKey,
    resultCode: result.output.ResultCode,
    resultMessage: result.output.ResultMessage
  };
}

async function getMigrationLogRows(pool, sessionKey) {
  if (!sessionKey) return [];

  const result = await pool.request()
    .input('sessionKey', sql.Int, sessionKey)
    .query(`
      SELECT
          EntryNo,
          Status,
          EntityID,
          ColumnID,
          ColumnValue,
          Comment
      FROM dbo.tdmMigrationLogWrk
      WHERE SessionKey = @sessionKey
      ORDER BY EntryNo;
    `);

  return result.recordset || [];
}

function formatMigrationLogRows(rows) {
  if (!rows || rows.length === 0) {
    return 'No rows were found in dbo.tdmMigrationLogWrk for this session.';
  }

  return rows.map(row => {
    return [
      `EntryNo: ${row.EntryNo}`,
      `Status: ${row.Status || ''}`,
      `EntityID: ${row.EntityID || ''}`,
      `ColumnID: ${row.ColumnID || ''}`,
      `ColumnValue: ${row.ColumnValue || ''}`,
      `Comment: ${row.Comment || ''}`
    ].join('\n');
  }).join('\n\n');
}

/*
  Replace this with your existing email-sending method if the app already has one.
  This function intentionally does not throw back to the Quadient endpoint.
*/
async function emailAccountingInvoiceImportFailure({
  stagingId,
  invoiceNumber,
  companyId,
  vendorId,
  vendId,
  sessionKey,
  resultCode,
  resultMessage,
  migrationLogRows,
  error
}) {
  const subject = `Sage AP import failed for Quadient invoice ${invoiceNumber || '(unknown)'}`;

  const body = `
A Quadient invoice was received and stored successfully, but the Sage Pending AP Voucher import failed.

Staging ID: ${stagingId}
Invoice Number / TranNo: ${invoiceNumber || ''}
Company: ${companyId || ''}
Vendor ID: ${vendorId || vendId || ''}
SessionKey: ${sessionKey || ''}
ResultCode: ${resultCode ?? ''}
ResultMessage: ${resultMessage || ''}

Exception:
${error ? (error.stack || error.message || String(error)) : 'None'}

Migration Log:
${formatMigrationLogRows(migrationLogRows)}
`.trim();

  writeLog('quadient-invoice.log', 'AP_IMPORT_FAILURE_EMAIL_BODY', {
    to: process.env.AP_IMPORT_FAILURE_EMAIL_TO,
    subject,
    body
  });

  /*
    Hook this into your existing email system.

    Example with a hypothetical sendEmail helper:

  await sendEmail({
    to: process.env.AP_IMPORT_FAILURE_EMAIL_TO,
    subject,
    text: body
  });
  */
}

async function processQuadientInvoiceToSageImport({ stagingId, payload }) {
  console.log(`Processing Quadient invoice staging ID ${stagingId} for Sage import...`);
  console.log('Payload:', payload);
  const invoiceNumber = cleanString(payload.invoiceNumber);
  const companyId = cleanString(payload.companyId);
  const vendorId = cleanString(payload.vendorId);

  let dimResult = null;
  let importResult = null;
  let migrationLogRows = [];

  try {
    writeLog('quadient-invoice.log', 'SAGE_IMPORT_STARTED', {
      stagingId,
      invoiceNumber,
      companyId,
      vendorId
    });

    /*
      This should be your existing function that reads QuadientInvoiceStaging /
      QuadientInvoiceLineStaging and inserts into StgPendVoucher / StgVoucherDetl.

      It should return at least:
        {
          tranNo: '...',
          vendId: '...',
          companyId: '...'
        }

      If your function already derives tranNo from invoiceNumber, that is fine.
    */
    dimResult = await pushQuadientInvoiceToSageDim({
      stagingId
    });

    importResult = await runSagePendingApImport(pool, {
      companyId: dimResult.companyId || companyId,
      tranNo: dimResult.tranNo,
      vendId: dimResult.vendId || vendorId
    });

    migrationLogRows = await getMigrationLogRows(pool, importResult.sessionKey);

    if (importResult.resultCode === 1) {
      await pool.request()
        .input('stagingId', sql.Int, stagingId)
        .query(`
          UPDATE dbo.QuadientInvoiceStaging
          SET ProcessingStatus = 'Imported'
          WHERE QuadientInvoiceStagingID = @stagingId;
        `);

      writeLog('quadient-invoice.log', 'SAGE_IMPORT_SUCCEEDED', {
        stagingId,
        invoiceNumber,
        companyId: dimResult.companyId || companyId,
        vendId: dimResult.vendId || vendorId,
        tranNo: dimResult.tranNo,
        sessionKey: importResult.sessionKey,
        resultCode: importResult.resultCode,
        resultMessage: importResult.resultMessage
      });

      return;
    }

    await pool.request()
      .input('stagingId', sql.Int, stagingId)
      .query(`
        UPDATE dbo.QuadientInvoiceStaging
        SET ProcessingStatus = 'SageImportFailed'
        WHERE QuadientInvoiceStagingID = @stagingId;
      `);

    writeLog('quadient-invoice.log', 'SAGE_IMPORT_FAILED', {
      stagingId,
      invoiceNumber,
      companyId: dimResult.companyId || companyId,
      vendId: dimResult.vendId || vendorId,
      tranNo: dimResult.tranNo,
      sessionKey: importResult.sessionKey,
      resultCode: importResult.resultCode,
      resultMessage: importResult.resultMessage,
      migrationLogRows
    });

    await emailAccountingInvoiceImportFailure({
      stagingId,
      invoiceNumber,
      companyId: dimResult.companyId || companyId,
      vendorId,
      vendId: dimResult.vendId || vendorId,
      sessionKey: importResult.sessionKey,
      resultCode: importResult.resultCode,
      resultMessage: importResult.resultMessage,
      migrationLogRows
    });

  } catch (err) {
    writeLog('quadient-invoice.log', 'SAGE_IMPORT_EXCEPTION', {
      stagingId,
      invoiceNumber,
      companyId,
      vendorId,
      dimResult,
      importResult,
      message: err.message,
      stack: err.stack
    });

    try {
      await pool.request()
        .input('stagingId', sql.Int, stagingId)
        .query(`
          UPDATE dbo.QuadientInvoiceStaging
          SET ProcessingStatus = 'SageImportFailed'
          WHERE QuadientInvoiceStagingID = @stagingId;
        `);
    } catch (statusErr) {
      writeLog('quadient-invoice.log', 'SAGE_IMPORT_STATUS_UPDATE_FAILED', {
        stagingId,
        message: statusErr.message,
        stack: statusErr.stack
      });
    }

    try {
      await emailAccountingInvoiceImportFailure({
        stagingId,
        invoiceNumber,
        companyId,
        vendorId,
        sessionKey: importResult?.sessionKey,
        resultCode: importResult?.resultCode ?? -999,
        resultMessage: importResult?.resultMessage || err.message,
        migrationLogRows,
        error: err
      });
    } catch (emailErr) {
      writeLog('quadient-invoice.log', 'AP_IMPORT_FAILURE_EMAIL_FAILED', {
        stagingId,
        invoiceNumber,
        message: emailErr.message,
        stack: emailErr.stack
      });
    }
  }
}

app.post('/quadient/invoice/reprocess/:stagingId', async (req, res) => {
  const stagingId = Number(req.params.stagingId);

  if (!Number.isInteger(stagingId) || stagingId <= 0) {
    return res.status(400).json({
      error: 'INVALID_STAGING_ID',
      message: 'A valid numeric stagingId is required.'
    });
  }

  try {
    const invoiceResult = await pool.request()
      .input('stagingId', sql.Int, stagingId)
      .query(`
        SELECT
            QuadientInvoiceStagingID,
            InvoiceNumber,
            VendKey,
            VendorID,
            CompanyID,
            ProcessingStatus
        FROM dbo.QuadientInvoiceStaging
        WHERE QuadientInvoiceStagingID = @stagingId;
      `);

    if (invoiceResult.recordset.length === 0) {
      return res.status(404).json({
        error: 'STAGING_ROW_NOT_FOUND',
        message: `No QuadientInvoiceStaging row found for ID ${stagingId}.`
      });
    }

    const invoice = invoiceResult.recordset[0];

    await pool.request()
      .input('stagingId', sql.Int, stagingId)
      .query(`
        UPDATE dbo.QuadientInvoiceStaging
        SET ProcessingStatus = 'ReadyForDIM'
        WHERE QuadientInvoiceStagingID = @stagingId;
      `);

    writeLog('quadient-invoice.log', 'MANUAL_REPROCESS_STARTED', {
      stagingId,
      invoiceNumber: invoice.InvoiceNumber,
      vendorId: invoice.VendorID,
      companyId: invoice.CompanyID
    });

    setImmediate(() => {
      processQuadientInvoiceToSageImport({
        stagingId,
        payload: {
          invoiceNumber: invoice.InvoiceNumber,
          vendorKey: invoice.VendKey,
          vendorId: invoice.VendorID,
          companyId: invoice.CompanyID
        }
      }).catch(err => {
        writeLog('quadient-invoice.log', 'MANUAL_REPROCESS_UNHANDLED_ERROR', {
          stagingId,
          invoiceNumber: invoice.InvoiceNumber,
          message: err.message,
          stack: err.stack
        });
      });
    });

    return res.status(202).json({
      status: 'reprocess_started',
      stagingId,
      invoiceNumber: invoice.InvoiceNumber,
      vendorId: invoice.VendorID,
      companyId: invoice.CompanyID
    });

  } catch (err) {
    writeLog('quadient-invoice.log', 'MANUAL_REPROCESS_FAILED_TO_START', {
      stagingId,
      message: err.message,
      stack: err.stack
    });

    return res.status(500).json({
      error: 'MANUAL_REPROCESS_FAILED_TO_START',
      message: err.message
    });
  }
});

app.post('/quadient/invoice', async (req, res) => {
  let payload = req.body;

  writeLog('quadient-invoice.log', 'DUPLICATE_CHECK_STARTED', {
    invoiceNumber: payload.invoiceNumber || null,
    companyId: payload.companyId || null,
    vendorId: payload.vendorId || null,
    vendorKey: payload.vendorKey || null,
    normalizedInvoiceNumber: cleanString(payload.invoiceNumber),
    normalizedCompanyId: cleanString(payload.companyId),
    normalizedVendorId: cleanString(payload.vendorId)
  });

  const duplicateResult = await pool.request()
  .input('companyId', sql.NVarChar(10), cleanString(payload.companyId))
  .input('vendorId', sql.NVarChar(50), cleanString(payload.vendorId))
  .input('invoiceNumber', sql.NVarChar(50), cleanString(payload.invoiceNumber))
  .query(`
    SELECT TOP 1
        QuadientInvoiceStagingID,
        ProcessingStatus,
        CreatedAt
    FROM dbo.QuadientInvoiceStaging WITH (UPDLOCK, HOLDLOCK)
    WHERE CompanyID = @companyId
      AND VendorID = @vendorId
      AND InvoiceNumber = @invoiceNumber
    ORDER BY QuadientInvoiceStagingID DESC;
  `);

  if (duplicateResult.recordset.length > 0) {
    const existing = duplicateResult.recordset[0];

    writeLog('quadient-invoice.log', 'DUPLICATE_INVOICE_REJECTED', {
      invoiceNumber: payload.invoiceNumber,
      companyId: payload.companyId,
      vendorId: payload.vendorId,
      existingStagingId: existing.QuadientInvoiceStagingID,
      existingProcessingStatus: existing.ProcessingStatus,
      existingCreatedAt: existing.CreatedAt
    });

    return res.status(409).json({
      error: 'DUPLICATE_INVOICE',
      message: 'Invoice has already been received for this company/vendor/invoice number.',
      existingStagingId: existing.QuadientInvoiceStagingID,
      processingStatus: existing.ProcessingStatus,
      createdAt: existing.CreatedAt
    });
  }
  writeLog('quadient-invoice.log', 'DUPLICATE_CHECK_RESULT', {
    invoiceNumber: cleanString(payload.invoiceNumber),
    companyId: cleanString(payload.companyId),
    vendorId: cleanString(payload.vendorId),
    duplicateCount: duplicateResult.recordset.length,
    duplicateRows: duplicateResult.recordset
  });

  if (Array.isArray(payload)) {
    if (payload.length !== 1) {
      writeLog('quadient-invoice.log', 'INVOICE_PAYLOAD_ARRAY_REJECTED', {
        arrayLength: payload.length
      });

      return res.status(400).json({
        error: 'VALIDATION_FAILED',
        message: 'Expected a single invoice object or an array containing exactly one invoice',
        details: [`Received array with ${payload.length} invoices`]
      });
    }

    payload = payload[0];

    writeLog('quadient-invoice.log', 'INVOICE_PAYLOAD_ARRAY_UNWRAPPED', {
      arrayLength: 1,
      invoiceNumber: payload.invoiceNumber || null
    });
  }

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
      const invoiceType = normalizeInvoiceType(payload.invoiceType || 'PO_MATCHED');

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
        .input('invoiceType', sql.NVarChar(20), invoiceType)
        .query(`
            INSERT INTO dbo.QuadientInvoiceStaging (
                InvoiceType,
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
                @invoiceType,
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
        const lineType = normalizeInvoiceLineType(line);

        await lineRequest
          .input('stagingId', sql.Int, stagingId)
          .input('lineType', sql.NVarChar(30), lineType)
          .input('lineNumber', sql.Int, line.lineNumber ?? null)
          .input('itemKey', sql.Int, line.itemKey ?? null)
          .input('itemId', sql.NVarChar(100), cleanString(line.itemId))
          .input('unitCost', sql.Decimal(19, 4), line.unitCost ?? null)
          .input('quantity', sql.Decimal(19, 4), line.quantity ?? null)
          .input('unitMeasure', sql.NVarChar(20), cleanString(line.unitMeasure))
          //.input('unitMeasKey', sql.Int, line.unitMeasKey ?? null)
          .input('lineAmount', sql.Decimal(19, 4), line.lineAmount)
          .input('poKey', sql.Int, line.poKey ?? null)
          .input('poNumber', sql.NVarChar(50), cleanString(line.poNumber))
          .input('poLineKey', sql.Int, line.poLineKey ?? null)
          .input('poLineNumber', sql.Int, line.poLineNumber ?? null)
          .input('rcvrLineKey', sql.Int, line.rcvrLineKey ?? null)
          .input('description', sql.NVarChar(sql.MAX), cleanString(line.description))
          .input('sTaxClassKey', sql.Int, line.sTaxClassKey ?? null)
          .input('department', sql.NVarChar(50), cleanString(line.department))
          .input('costCenter', sql.NVarChar(50), cleanString(line.costCenter))
          .input('glAccountKey', sql.Int, line.glAccountKey ?? null)
          .input('glAccountNumber', sql.NVarChar(50), cleanString(line.glAccountNumber))
          .input('glAccountDescription', sql.NVarChar(255), cleanString(line.glAccountDescription))
          .input('quantityOrdered', sql.Decimal(19, 4), line.quantityOrdered ?? null)
          .input('quantityReceived', sql.Decimal(19, 4), line.quantityReceived ?? null)
          .input('quantityInvoiced', sql.Decimal(19, 4), line.quantityInvoiced ?? null)
          .input('quantityOpenToReceive', sql.Decimal(19, 4), line.quantityOpenToReceive ?? null)
          .input('quantityReturnedForCredit', sql.Decimal(19, 4), line.quantityReturnedForCredit ?? null)
          .input('quantityReturnedForReplacement', sql.Decimal(19, 4), line.quantityReturnedForReplacement ?? null)
          .query(`
            INSERT INTO dbo.QuadientInvoiceLineStaging (
                QuadientInvoiceStagingID,
                LineType,
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
                GLAccountNumber,
                GLAccountDescription,
                QuantityOrdered,
                QuantityReceived,
                QuantityInvoiced,
                QuantityOpenToReceive,
                QuantityReturnedForCredit,
                QuantityReturnedForReplacement
            )
            VALUES (
                @stagingId,
                @lineType,
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
                @glAccountNumber,
                @glAccountDescription,
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
        companyId: payload.companyId || null,
        lineCount: payload.lines.length
      });

      /*
        Respond to Quadient once we have safely accepted/stored the invoice.
        Sage import is an internal AP process and should not make the Quadient
        upload fail.
      */
      res.status(201).json({
        status: 'received',
        processingStatus: 'ReadyForDIM',
        stagingId,
        invoiceNumber: payload.invoiceNumber,
        vendorKey: payload.vendorKey ?? null,
        vendorId: payload.vendorId || null,
        lineCount: payload.lines.length
      });

      /*
        Start Sage import after responding to Quadient.
        Errors are logged and emailed to AP, not returned to Quadient.
      */
      setImmediate(() => {
        processQuadientInvoiceToSageImport({
          stagingId,
          payload
        }).catch(err => {
          writeLog('quadient-invoice.log', 'SAGE_IMPORT_BACKGROUND_UNHANDLED_ERROR', {
            stagingId,
            invoiceNumber: payload?.invoiceNumber || null,
            message: err.message,
            stack: err.stack
          });
        });
      });

      return;

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