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
            inv.TranCmnt AS invoiceDescription,
            inv.CreateDate AS createdAt,
            inv.UpdateDate AS updatedAt,
            v.VendID AS vendorId,
            v.VendName AS vendorName
        FROM dbo.tapVoucher inv
        INNER JOIN dbo.tapVendor v
            ON inv.VendKey = v.VendKey
        WHERE
            inv.Balance > 0
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