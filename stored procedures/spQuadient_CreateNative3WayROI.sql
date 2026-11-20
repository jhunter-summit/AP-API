USE [mas500_app]
GO
/****** Object:  StoredProcedure [dbo].[spQuadient_CreateNative3WayROI]    Script Date: 11/20/2026 10:56:06 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

ALTER   PROCEDURE [dbo].[spQuadient_CreateNative3WayROI]
    @StagingID int,
    @UserID    varchar(30)
WITH EXECUTE AS OWNER
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

------------------------------------------------------------
-- CLEAN UP TEMP TABLES FROM A PRIOR RUN IN THIS SSMS SESSION
------------------------------------------------------------
IF OBJECT_ID('tempdb..#tciSTaxCodeTran') IS NOT NULL
    DROP TABLE #tciSTaxCodeTran;

IF OBJECT_ID('tempdb..#PmtTerms') IS NOT NULL
    DROP TABLE #PmtTerms;

IF OBJECT_ID('tempdb..#tapAPIValid') IS NOT NULL
    DROP TABLE #tapAPIValid;

IF OBJECT_ID('tempdb..#tapVoucherDetl') IS NOT NULL
    DROP TABLE #tapVoucherDetl;

IF OBJECT_ID('tempdb..#tapVoucherLineDist') IS NOT NULL
    DROP TABLE #tapVoucherLineDist;

IF OBJECT_ID('tempdb..#tciSTaxDelete') IS NOT NULL
    DROP TABLE #tciSTaxDelete;

IF OBJECT_ID('tempdb..#tciSTaxTran') IS NOT NULL
    DROP TABLE #tciSTaxTran;

IF OBJECT_ID('tempdb..#tciSTaxLine') IS NOT NULL
    DROP TABLE #tciSTaxLine;

IF OBJECT_ID('tempdb..#STaxSums') IS NOT NULL
    DROP TABLE #STaxSums;

IF OBJECT_ID('tempdb..#tciSTaxExmpt') IS NOT NULL
    DROP TABLE #tciSTaxExmpt;

IF OBJECT_ID('tempdb..#tciSTaxCodeLineCalc') IS NOT NULL
    DROP TABLE #tciSTaxCodeLineCalc;

IF OBJECT_ID('tempdb..#tciSTaxCodeCalc') IS NOT NULL
    DROP TABLE #tciSTaxCodeCalc;

IF OBJECT_ID('tempdb..#HeaderKeyNeeded') IS NOT NULL
    DROP TABLE #HeaderKeyNeeded;

IF OBJECT_ID('tempdb..#AddrKeys') IS NOT NULL
    DROP TABLE #AddrKeys;

IF OBJECT_ID('tempdb..#UnmaskedGLAcct') IS NOT NULL
    DROP TABLE #UnmaskedGLAcct;

IF OBJECT_ID('tempdb..#tpoVouchMatchWrk') IS NOT NULL
    DROP TABLE #tpoVouchMatchWrk;


------------------------------------------------------------
-- Native Sage 500 Receipt-of-Invoice / 3-way FINAL lifecycle test
--
-- IMPORTANT:
--   THIS VERSION COMMITS TO THE TEST DATABASE so Accounting can
--   inspect/post the pending Receipt of Invoice through Sage.
--   It may run only in mas500_app__03302026.
--
--   This test specifically proves the full batch lifecycle:
--   create -> match -> spapBatchCleanup -> unlock -> AP-to-PO
--   batch conversion -> commit pending voucher.
------------------------------------------------------------

DECLARE
        @CompanyID          varchar(3),
        @VendorID           varchar(12),
        @VendKey            int,
        @PurchVendAddrKey   int,
        @POKey              int,
        @PONo               varchar(10),

        @TranNo             varchar(15),
        @InvoiceDate        datetime,
        @PostDate           datetime = CONVERT(date, GETDATE()),

        @PurchAmt           decimal(15,3),
        @FreightAmt         decimal(15,3) = 0.000,
        @InvoiceSTaxAmt     decimal(15,3),
        @TranAmt            decimal(15,3),

        @STaxClassKey       int,
        @ExpectedSTaxSchdKey int,
        @ExpectedSTaxSchdID   varchar(15),

        @BatchKey           int,
        @Spid               int,
        @VouchKey           int,
        @TranID             varchar(18),
        @UniqueID           varchar(80),

        @RetVal             int,
        @SmallRetVal        smallint,
        @MatchRetVal        int,
        @TempBatchKey       int,
        @POBatchNo          int,
        @POBatchRetVal      smallint,

        @LineItemKey        int,
        @LineDescription    varchar(40),
        @LineQuantity       decimal(16,8),
        @LineUnitCost       decimal(15,5),
        @LineAmount         decimal(15,3),
        @LinePOLineKey      int,
        @LinePOLineNo       int,
        @LineRcvrLineKey    int,
        @LineUnitMeasKey    int,
        @LineGLAcctKey      int,
        @LineGLAcctNo       varchar(100),
        @LineSTaxClassKey   int,
        @LineSTaxClassID    varchar(15);

------------------------------------------------------------
-- HARD SAFETY GUARDS
------------------------------------------------------------

IF DB_NAME() <> 'mas500_app'
    THROW 50000,
        'WRONG DATABASE. Native 3-way procedure must run in mas500_app.',
        1;

------------------------------------------------------------
-- LOAD STAGED INVOICE HEADER
------------------------------------------------------------

SELECT
    @CompanyID   = LTRIM(RTRIM(h.CompanyID)),
    @VendorID    = LTRIM(RTRIM(h.VendorID)),
    @VendKey     = h.VendKey,
    @TranNo      = LEFT(LTRIM(RTRIM(h.InvoiceNumber)), 15),
    @InvoiceDate = h.InvoiceDate,
    @TranAmt     = CONVERT(decimal(15,3), h.TotalAmount)
FROM dbo.QuadientInvoiceStaging h
WHERE h.QuadientInvoiceStagingID = @StagingID
  AND h.InvoiceType = 'PO_MATCHED';

IF @CompanyID IS NULL
    THROW 50001,
        'PO_MATCHED staging row was not found.',
        1;


------------------------------------------------------------
-- REQUIRE THE INVOICE TO STILL BE HELD FOR 3-WAY PROCESSING
------------------------------------------------------------

IF NOT EXISTS
(
    SELECT 1
    FROM dbo.QuadientInvoiceStaging
    WHERE QuadientInvoiceStagingID = @StagingID
      AND InvoiceType = 'PO_MATCHED'
      AND ProcessingStatus = 'ThreeWayPending'
)
    THROW 50002,
        'Invoice is not in ThreeWayPending status.',
        1;


------------------------------------------------------------
-- DUPLICATE SAGE VOUCHER GUARD
------------------------------------------------------------

IF EXISTS
(
    SELECT 1
    FROM dbo.tapPendVoucher
    WHERE CompanyID = @CompanyID
      AND TranNo = @TranNo
)
    THROW 50003,
        'A pending Sage voucher already exists for this invoice.',
        1;

IF EXISTS
(
    SELECT 1
    FROM dbo.tapVoucher
    WHERE CompanyID = @CompanyID
      AND TranNo = @TranNo
)
    THROW 50004,
        'A posted Sage voucher already exists for this invoice.',
        1;

-- Confirm the staged vendor still matches Sage.
IF NOT EXISTS
(
    SELECT 1
    FROM dbo.tapVendor v
    WHERE v.VendKey = @VendKey
      AND v.CompanyID = @CompanyID
      AND LTRIM(RTRIM(v.VendID)) = @VendorID
)
    THROW 50010,
        'Staged vendor does not match the Sage vendor record.',
        1;

------------------------------------------------------------
-- PURCHASE-FROM ADDRESS / TAX SCHEDULE
------------------------------------------------------------

SELECT
    @PurchVendAddrKey = v.DfltPurchAddrKey
FROM dbo.tapVendor v
WHERE v.VendKey = @VendKey
  AND v.CompanyID = @CompanyID;

IF @PurchVendAddrKey IS NULL
    THROW 50011,
        'Vendor does not have a default purchase-from address.',
        1;

SELECT
    @ExpectedSTaxSchdKey = va.STaxSchdKey
FROM dbo.tapVendAddr va
WHERE va.AddrKey = @PurchVendAddrKey;

IF @ExpectedSTaxSchdKey IS NULL
    THROW 50012,
        'Vendor purchase-from address does not have a sales-tax schedule.',
        1;

SELECT
    @ExpectedSTaxSchdID = LTRIM(RTRIM(s.STaxSchdID))
FROM dbo.tciSTaxSchedule s
WHERE s.STaxSchdKey = @ExpectedSTaxSchdKey;

IF @ExpectedSTaxSchdID IS NULL
    THROW 50024,
        'Could not resolve sales-tax schedule ID from Sage.',
        1;

------------------------------------------------------------
-- REQUIRE AT LEAST ONE PO-MATCHED LINE
------------------------------------------------------------

IF NOT EXISTS
(
    SELECT 1
    FROM dbo.QuadientInvoiceLineStaging l
    WHERE l.QuadientInvoiceStagingID = @StagingID
      AND l.LineType = 'PO_MATCHED'
)
    THROW 50013,
        'PO_MATCHED invoice has no PO-matched staging lines.',
        1;


------------------------------------------------------------
-- FIRST PRODUCTION VERSION:
-- REQUIRE ALL PO-MATCHED LINES TO BELONG TO ONE PO
------------------------------------------------------------

IF
(
    SELECT COUNT(DISTINCT l.POKey)
    FROM dbo.QuadientInvoiceLineStaging l
    WHERE l.QuadientInvoiceStagingID = @StagingID
      AND l.LineType = 'PO_MATCHED'
) <> 1
    THROW 50014,
        'Initial native 3-way importer requires exactly one PO per invoice.',
        1;


------------------------------------------------------------
-- RESOLVE HEADER PO
------------------------------------------------------------

SELECT TOP (1)
    @POKey = l.POKey,
    @PONo  = LTRIM(RTRIM(l.PONumber))
FROM dbo.QuadientInvoiceLineStaging l
WHERE l.QuadientInvoiceStagingID = @StagingID
  AND l.LineType = 'PO_MATCHED';

IF @POKey IS NULL OR @PONo IS NULL
    THROW 50015,
        'PO-matched staging line is missing POKey or PONumber.',
        1;


------------------------------------------------------------
-- VERIFY PO EXISTS AND BELONGS TO SAME COMPANY/VENDOR
------------------------------------------------------------

IF NOT EXISTS
(
    SELECT 1
    FROM dbo.tpoPurchOrder po
    WHERE po.POKey = @POKey
      AND po.CompanyID = @CompanyID
      AND po.VendKey = @VendKey
      AND LTRIM(RTRIM(po.TranNo)) = @PONo
)
    THROW 50016,
        'Staged PO does not match the Sage purchase order.',
        1;


------------------------------------------------------------
-- VALIDATE EVERY PO-MATCHED LINE AGAINST SAGE
------------------------------------------------------------

IF EXISTS
(
    SELECT 1
    FROM dbo.QuadientInvoiceLineStaging l
    LEFT JOIN dbo.tpoPOLine pol
        ON pol.POLineKey = l.POLineKey
       AND pol.POKey = l.POKey
    WHERE l.QuadientInvoiceStagingID = @StagingID
      AND l.LineType = 'PO_MATCHED'
      AND
      (
          l.POLineKey IS NULL
          OR l.RcvrLineKey IS NULL
          OR pol.POLineKey IS NULL
          OR pol.POLineNo <> l.POLineNumber
      )
)
    THROW 50017,
        'One or more staged PO lines do not match Sage PO lines.',
        1;


------------------------------------------------------------
-- VERIFY RECEIVER LINES BELONG TO THE PO LINES
------------------------------------------------------------

IF EXISTS
(
    SELECT 1
    FROM dbo.QuadientInvoiceLineStaging l
    LEFT JOIN dbo.tpoRcvrLine rl
        ON rl.RcvrLineKey = l.RcvrLineKey
       AND rl.POLineKey = l.POLineKey
    WHERE l.QuadientInvoiceStagingID = @StagingID
      AND l.LineType = 'PO_MATCHED'
      AND rl.RcvrLineKey IS NULL
)
    THROW 50018,
        'One or more staged receiver lines do not match the Sage PO lines.',
        1;

------------------------------------------------------------
-- VERIFY RECEIVER HAS ENOUGH UNINVOICED QUANTITY
------------------------------------------------------------

DECLARE @ReceiverAvailability TABLE
(
    RcvrLineKey         int,
    RequestedQty        decimal(16,8),
    QtyReceived         decimal(16,8),
    QtyAlreadyInvoiced  decimal(16,8),
    QtyAvailable        decimal(16,8)
);

;WITH Requested AS
(
    SELECT
        l.RcvrLineKey,
        SUM(CONVERT(decimal(16,8), ISNULL(l.Quantity, 0))) AS RequestedQty
    FROM dbo.QuadientInvoiceLineStaging l
    WHERE l.QuadientInvoiceStagingID = @StagingID
      AND l.LineType = 'PO_MATCHED'
    GROUP BY l.RcvrLineKey
),
Received AS
(
    SELECT
        rld.RcvrLineKey,
        SUM(CONVERT(decimal(16,8), ISNULL(rld.QtyRcvd, 0))) AS QtyReceived
    FROM dbo.tpoRcvrLineDist rld
    GROUP BY rld.RcvrLineKey
),
Invoiced AS
(
    SELECT
        rld.RcvrLineKey,
        SUM(CONVERT(decimal(16,8), ISNULL(rvld.QtyInvcd, 0))) AS QtyAlreadyInvoiced
    FROM dbo.tpoRcvrLineDist rld
    JOIN dbo.tpoRcvrVouchLnDist rvld
        ON rvld.RcvrLineDistKey = rld.RcvrLineDistKey
    GROUP BY rld.RcvrLineKey
)
INSERT INTO @ReceiverAvailability
(
    RcvrLineKey,
    RequestedQty,
    QtyReceived,
    QtyAlreadyInvoiced,
    QtyAvailable
)
SELECT
    rq.RcvrLineKey,
    rq.RequestedQty,
    ISNULL(rc.QtyReceived, 0),
    ISNULL(iv.QtyAlreadyInvoiced, 0),
    ISNULL(rc.QtyReceived, 0)
        - ISNULL(iv.QtyAlreadyInvoiced, 0)
FROM Requested rq
LEFT JOIN Received rc
    ON rc.RcvrLineKey = rq.RcvrLineKey
LEFT JOIN Invoiced iv
    ON iv.RcvrLineKey = rq.RcvrLineKey;


-- Diagnostic output during development.
SELECT
    RcvrLineKey,
    RequestedQty,
    QtyReceived,
    QtyAlreadyInvoiced,
    QtyAvailable
FROM @ReceiverAvailability;


IF EXISTS
(
    SELECT 1
    FROM @ReceiverAvailability
    WHERE QtyAvailable < RequestedQty
)
    THROW 50025,
        'One or more receiver lines do not have enough uninvoiced quantity remaining.',
        1;

------------------------------------------------------------
-- CALCULATE PURCHASE AMOUNT FROM ALL INVOICE DETAIL LINES
--
-- PO_MATCHED + ADDITIONAL_CHARGE both become voucher detail.
-- Header FreightAmt stays zero; freight/shipping remains a detail line.
------------------------------------------------------------

SELECT
    @PurchAmt =
        CONVERT(decimal(15,3),
            ISNULL(SUM(l.LineAmount), 0)
        )
FROM dbo.QuadientInvoiceLineStaging l
WHERE l.QuadientInvoiceStagingID = @StagingID;

SET @FreightAmt = 0.000;


------------------------------------------------------------
-- DERIVE HEADER TAX AS:
-- Invoice total - sum of staged detail
------------------------------------------------------------

SET @InvoiceSTaxAmt =
    CONVERT(decimal(15,3),
        @TranAmt - ISNULL(@PurchAmt, 0)
    );

-- Prevent tiny decimal noise.
IF ABS(@InvoiceSTaxAmt) < 0.005
    SET @InvoiceSTaxAmt = 0.000;

IF @InvoiceSTaxAmt < 0
    THROW 50019,
        'Calculated invoice sales tax is negative; staged detail exceeds invoice total.',
        1;


------------------------------------------------------------
-- USE THE FIRST PO LINE TAX CLASS ONLY AS HEADER/DEFAULT CONTEXT.
-- EACH LINE WILL STILL USE ITS OWN STAGED/SAGE TAX CLASS LATER.
------------------------------------------------------------

SELECT TOP (1)
    @STaxClassKey = l.STaxClassKey
FROM dbo.QuadientInvoiceLineStaging l
WHERE l.QuadientInvoiceStagingID = @StagingID
  AND l.LineType = 'PO_MATCHED'
ORDER BY l.LineNumber;

IF @STaxClassKey IS NULL
    THROW 50020,
        'PO-matched staging line is missing STaxClassKey.',
        1;


------------------------------------------------------------
-- LOOKUP-ONLY CHECKPOINT
-- REMOVE THIS RETURN WHEN THE VALUES HAVE BEEN VERIFIED.
------------------------------------------------------------

SELECT
    @StagingID             AS StagingID,
    @CompanyID             AS CompanyID,
    @VendorID              AS VendorID,
    @VendKey               AS VendKey,
    @PurchVendAddrKey      AS PurchVendAddrKey,
    @ExpectedSTaxSchdKey   AS ExpectedSTaxSchdKey,
    @POKey                 AS POKey,
    @PONo                  AS PONumber,
    @TranNo                AS TranNo,
    @InvoiceDate           AS InvoiceDate,
    @PostDate              AS PostDate,
    @PurchAmt              AS PurchAmt,
    @FreightAmt            AS FreightAmt,
    @InvoiceSTaxAmt        AS InvoiceSTaxAmt,
    @TranAmt               AS TranAmt,
    @ExpectedSTaxSchdID    AS STaxSchdID,
    @STaxClassKey          AS STaxClassKey;
    


SELECT
    l.LineNumber,
    l.LineType,
    l.ItemKey,
    l.ItemID,
    l.Description,
    l.Quantity,
    l.UnitCost,
    l.LineAmount,
    l.POKey,
    l.PONumber,
    l.POLineKey,
    l.POLineNumber,
    l.RcvrLineKey,
    l.STaxClassKey,
    l.GLAcctKey,
    l.GLAccountNumber
FROM dbo.QuadientInvoiceLineStaging l
WHERE l.QuadientInvoiceStagingID = @StagingID
ORDER BY l.LineNumber;

------------------------------------------------------------
-- BUILD ALL VOUCHER DETAIL LINES FROM STAGING
--
-- PO_MATCHED:
--   tied to PO / PO line / receiver line
--
-- ADDITIONAL_CHARGE:
--   ordinary expense detail such as SHIPPING
--   no PO / receiver / UOM link
------------------------------------------------------------

DECLARE @InvoiceLines TABLE
(
    RowNo             int             NOT NULL,
    LineNumber        int             NULL,
    LineType          varchar(30)     NOT NULL,

    ItemKey           int             NULL,
    Description       varchar(40)     NULL,
    Quantity          decimal(16,8)   NULL,
    UnitCost          decimal(15,5)   NULL,
    LineAmount        decimal(15,3)   NOT NULL,

    POKey             int             NULL,
    PONumber          varchar(10)     NULL,
    POLineKey         int             NULL,
    POLineNumber      int             NULL,
    RcvrLineKey       int             NULL,

    UnitMeasKey       int             NULL,

    GLAcctKey         int             NULL,
    GLAcctNo          varchar(100)    NULL,

    STaxClassKey      int             NULL,
    STaxClassID       varchar(15)     NULL,

    MatchStatus       smallint        NULL
);


INSERT INTO @InvoiceLines
(
    RowNo,
    LineNumber,
    LineType,

    ItemKey,
    Description,
    Quantity,
    UnitCost,
    LineAmount,

    POKey,
    PONumber,
    POLineKey,
    POLineNumber,
    RcvrLineKey,

    UnitMeasKey,

    GLAcctKey,
    GLAcctNo,

    STaxClassKey,
    STaxClassID,

    MatchStatus
)
SELECT
    ROW_NUMBER() OVER
    (
        ORDER BY
            ISNULL(l.LineNumber, 2147483647),
            CASE WHEN l.LineType = 'PO_MATCHED' THEN 0 ELSE 1 END
    ) AS RowNo,

    l.LineNumber,
    l.LineType,

    CASE
        WHEN l.LineType = 'PO_MATCHED'
            THEN l.ItemKey
        ELSE NULL
    END AS ItemKey,

    LEFT(LTRIM(RTRIM(l.Description)), 40) AS Description,

    CASE
        WHEN l.LineType = 'PO_MATCHED'
            THEN CONVERT(decimal(16,8), l.Quantity)

        -- Proven native Sage behavior for SHIPPING /
        -- additional-charge expense details.
        WHEN l.LineType = 'ADDITIONAL_CHARGE'
            THEN CONVERT(decimal(16,8), 1)

        ELSE NULL
    END AS Quantity,

    CASE
        WHEN l.LineType = 'PO_MATCHED'
            THEN CONVERT(decimal(15,5), l.UnitCost)

        -- Ordinary expense line: Qty = 1, therefore UnitCost
        -- equals the extended line amount.
        WHEN l.LineType = 'ADDITIONAL_CHARGE'
            THEN CONVERT(decimal(15,5), l.LineAmount)

        ELSE NULL
    END AS UnitCost,

    CONVERT(decimal(15,3), l.LineAmount) AS LineAmount,

    CASE WHEN l.LineType = 'PO_MATCHED' THEN l.POKey END,
    CASE WHEN l.LineType = 'PO_MATCHED'
         THEN LTRIM(RTRIM(l.PONumber))
    END,
    CASE WHEN l.LineType = 'PO_MATCHED' THEN l.POLineKey END,
    CASE WHEN l.LineType = 'PO_MATCHED' THEN l.POLineNumber END,
    CASE WHEN l.LineType = 'PO_MATCHED' THEN l.RcvrLineKey END,

    CASE
        WHEN l.LineType = 'PO_MATCHED'
            THEN pol.UnitMeasKey
        ELSE NULL
    END AS UnitMeasKey,

    l.GLAcctKey,
    LTRIM(RTRIM(l.GLAccountNumber)),

    l.STaxClassKey,

    CASE
        WHEN l.LineType = 'PO_MATCHED'
            THEN LTRIM(RTRIM(tc.STaxClassID))

        -- The successful SHIPPING test passed the tax-class
        -- key and a NULL tax-class ID.
        WHEN l.LineType = 'ADDITIONAL_CHARGE'
            THEN NULL

        ELSE NULL
    END AS STaxClassID,

    CASE
        WHEN l.LineType = 'ADDITIONAL_CHARGE'
            THEN 4
        ELSE NULL
    END AS MatchStatus

FROM dbo.QuadientInvoiceLineStaging l

LEFT JOIN dbo.tpoPOLine pol
    ON pol.POLineKey = l.POLineKey
   AND pol.POKey = l.POKey

LEFT JOIN dbo.tciSTaxClass tc
    ON tc.STaxClassKey = l.STaxClassKey

WHERE l.QuadientInvoiceStagingID = @StagingID
  AND l.LineType IN
      (
          'PO_MATCHED',
          'ADDITIONAL_CHARGE'
      );


------------------------------------------------------------
-- VALIDATE RESOLVED DETAIL LINES
------------------------------------------------------------

IF NOT EXISTS
(
    SELECT 1
    FROM @InvoiceLines
)
    THROW 50026,
        'No supported invoice detail lines were found.',
        1;


IF EXISTS
(
    SELECT 1
    FROM @InvoiceLines
    WHERE Description IS NULL
       OR LTRIM(RTRIM(Description)) = ''
       OR LineAmount IS NULL
)
    THROW 50027,
        'One or more invoice detail lines are missing description or amount.',
        1;


------------------------------------------------------------
-- PO-MATCHED LINES REQUIRE SAGE PO/RECEIVER CONTEXT
------------------------------------------------------------

IF EXISTS
(
    SELECT 1
    FROM @InvoiceLines
    WHERE LineType = 'PO_MATCHED'
      AND
      (
          POKey IS NULL
          OR POLineKey IS NULL
          OR POLineNumber IS NULL
          OR RcvrLineKey IS NULL
          OR Quantity IS NULL
          OR UnitCost IS NULL
          OR UnitMeasKey IS NULL
          OR STaxClassKey IS NULL
          OR STaxClassID IS NULL
      )
)
    THROW 50028,
        'One or more PO-matched lines could not be fully resolved from Sage.',
        1;


------------------------------------------------------------
-- EVERY DETAIL LINE MUST HAVE A VALID GL ACCOUNT
------------------------------------------------------------

IF EXISTS
(
    SELECT 1
    FROM @InvoiceLines il
    LEFT JOIN dbo.tglAccount ga
        ON ga.GLAcctKey = il.GLAcctKey
       AND LTRIM(RTRIM(ga.GLAcctNo)) = il.GLAcctNo
    WHERE ga.GLAcctKey IS NULL
)
    THROW 50029,
        'One or more invoice detail lines have an invalid Sage GL account.',
        1;


------------------------------------------------------------
-- EVERY DETAIL LINE MUST HAVE A TAX CLASS KEY
------------------------------------------------------------

IF EXISTS
(
    SELECT 1
    FROM @InvoiceLines
    WHERE STaxClassKey IS NULL
)
    THROW 50030,
        'One or more invoice detail lines are missing a sales-tax class.',
        1;


------------------------------------------------------------
-- DEVELOPMENT CHECKPOINT:
-- THESE ARE THE LINES THAT WILL FEED spapGetVouchDtl
------------------------------------------------------------

SELECT
    RowNo,
    LineNumber,
    LineType,
    ItemKey,
    Description,
    Quantity,
    UnitCost,
    LineAmount,
    POKey,
    PONumber,
    POLineKey,
    POLineNumber,
    RcvrLineKey,
    UnitMeasKey,
    GLAcctKey,
    GLAcctNo,
    STaxClassKey,
    STaxClassID,
    MatchStatus
FROM @InvoiceLines
ORDER BY RowNo;

------------------------------------------------------------
-- LOOKUP-ONLY DIAGNOSTIC OUTPUT
------------------------------------------------------------

SELECT
    RowNo,
    LineNumber,
    LineType,
    ItemKey,
    Description,
    Quantity,
    UnitCost,
    LineAmount,
    POKey,
    PONumber,
    POLineKey,
    POLineNumber,
    RcvrLineKey,
    UnitMeasKey,
    GLAcctKey,
    GLAcctNo,
    STaxClassKey,
    STaxClassID,
    MatchStatus
FROM @InvoiceLines
ORDER BY RowNo;

SELECT
    @StagingID       AS StagingID,
    @CompanyID       AS CompanyID,
    @VendorID        AS VendorID,
    @VendKey         AS VendKey,
    @PONo            AS PONumber,
    @PurchAmt        AS PurchAmt,
    @InvoiceSTaxAmt  AS InvoiceSTaxAmt,
    @TranAmt         AS TranAmt;

------------------------------------------------------------
-- LOOKUP-ONLY DIAGNOSTIC OUTPUT
------------------------------------------------------------

SELECT
    RowNo,
    LineNumber,
    LineType,
    ItemKey,
    Description,
    Quantity,
    UnitCost,
    LineAmount,
    POKey,
    PONumber,
    POLineKey,
    POLineNumber,
    RcvrLineKey,
    UnitMeasKey,
    GLAcctKey,
    GLAcctNo,
    STaxClassKey,
    STaxClassID,
    MatchStatus
FROM @InvoiceLines
ORDER BY RowNo;

SELECT
    @StagingID       AS StagingID,
    @CompanyID       AS CompanyID,
    @VendorID        AS VendorID,
    @VendKey         AS VendKey,
    @PONo        AS PONumber,
    @PurchAmt        AS PurchAmt,
    @InvoiceSTaxAmt  AS InvoiceSTaxAmt,
    @TranAmt         AS TranAmt;

-- RETURN;


BEGIN TRY

    BEGIN TRAN;

    --------------------------------------------------------
    -- Sage API work tables
    --------------------------------------------------------

    CREATE TABLE #tapAPIValid
    (
        AcuityUserID         varchar(30)   NULL,
        ApplySeqNo           int           NULL,
        BatchKey             int           NULL,
        BatchID              varchar(12)   NULL,
        BatchType            int           NULL,
        BatchOvrdPurch       smallint      NULL,
        BatchOvrdSegKey      int           NULL,
        BatchOvrdSegVal      varchar(15)   NULL,
        CashAcctKey          int           NULL,
        ClassOvrdPurch       smallint      NULL,
        ClassOvrdSegKey      int           NULL,
        ClassOvrdSegVal      varchar(15)   NULL,
        CompanyID            varchar(3)    NULL,
        CreateGL             smallint      NULL,
        CurrExchRate         float         NULL,
        ContactKey           int           NULL,
        CurrExchSchdKey      int           NULL,
        DocCurrID            varchar(3)    NULL,
        HomeCurrID           varchar(3)    NULL,
        HomeRoundAmt         smallint      NULL,
        HoldPmt              smallint      NULL,
        ImportLogKey         int           NULL,
        InvcRcptDate         datetime      NULL,
        NextSeqNo            int           NULL,
        LockID               int           NULL,
        RoundDocAmt          int           NULL,
        RemitToAddrKey       int           NULL,
        RemitToAddrName      varchar(40)   NULL,
        RoundQty             smallint      NULL,
        RoundPrice           smallint      NULL,
        RoundCost            smallint      NULL,
        RetntAmt             decimal(15,3) NULL,
        RetntRate            decimal(12,6) NULL,
        RTAddrLine1          varchar(40)   NULL,
        RTAddrLine2          varchar(40)   NULL,
        RTAddrLine3          varchar(40)   NULL,
        RTAddrLine4          varchar(40)   NULL,
        RTAddrLine5          varchar(40)   NULL,
        RTCity               varchar(20)   NULL,
        RTState              varchar(3)    NULL,
        RTCountryID          varchar(3)    NULL,
        RTPostalCode         varchar(9)    NULL,
        RemitToVendAddrKey   int           NULL,
        FOBKey               int           NULL,
        PmtTermsKey          int           NULL,
        PurchFromAddrName    varchar(40)   NULL,
        PurchAddrLine1       varchar(40)   NULL,
        PurchAddrLine2       varchar(40)   NULL,
        PurchAddrLine3       varchar(40)   NULL,
        PurchAddrLine4       varchar(40)   NULL,
        PurchAddrLine5       varchar(40)   NULL,
        PurchCity            varchar(20)   NULL,
        PurchState           varchar(3)    NULL,
        PurchCountryID       varchar(3)    NULL,
        PurchPostalCode      varchar(9)    NULL,
        PurchFromVendAddrKey int           NULL,
        ReasonCodeKey        int           NULL,
        SeqNo                int           NULL,
        FreightAmt           decimal(15,3) NULL,
        SeparateCheck        smallint      NULL,
        ShipMethKey          int           NULL,
        ShipZoneKey          int           NULL,
        STaxSchdKey          int           NULL,
        PurchFromAddrKey     int           NULL,
        TranCmnt             varchar(50)   NULL,
        TranNo               varchar(15)   NULL,
        TranStatus           smallint      NULL,
        TranType             int           NULL,
        TranDate             datetime      NULL,
        TranID               varchar(18)   NULL,
        TrackSTaxOnPurch     smallint      NULL,
        UseMultCurr          smallint      NULL,
        VendKey              int           NULL,
        VendAddrKey          int           NULL,
        VendClassKey         int           NULL,
        VendPurchAcctKey     int           NULL,
        VouchKey             int           NULL,
        VouchNo              varchar(10)   NULL,
        V1099Box             varchar(3)    NULL,
        V1099Form            smallint      NULL,
        V1099BoxText         varchar(3)    NULL,
        Spid                 int           NULL,
        LogSuccessful        smallint      NULL,
        RecordNumber         int           NULL,
        ReferenceID          varchar(80)   NULL,
        InputTranNo          varchar(15)   NULL,
        VendID               varchar(12)   NULL,
        Use1099              smallint      NULL,
        LastRetVal           smallint      NULL,
        AcctRefUsage         smallint      NULL
    );

    CREATE TABLE #tapVoucherDetl
    (
        TargetCompanyID varchar(3)     NULL,
        VouchKey        int            NULL,
        VoucherLineKey  int            NULL,
        CmntOnly        smallint       NULL,
        Description     varchar(40)    NULL,
        ExtAmt          decimal(15,3)  NULL,
        RetntAmt        decimal(15,3)  NULL,
        RetntRate       decimal(12,6)  NULL,
        ExtCmnt         varchar(255)   NULL,
        ItemKey         int            NULL,
        SeqNo           int            NULL,
        STaxClassKey    int            NULL,
        UnitCost        decimal(15,5)  NULL,
        UnitMeasKey     int            NULL,
        MatchStatus     smallint       NULL,
        POLineKey       int            NULL,
        ReturnType      smallint       NULL,
        RcvrLineKey     int            NULL
    );

    CREATE TABLE #tapVoucherLineDist
    (
        VouchKey           int            NULL,
        VoucherLineKey     int            NULL,
        VoucherLineDistKey int            NULL,
        AcctRefKey         int            NULL,
        FOBKey             int            NULL,
        STaxTranKey        int            NULL,
        STaxSchdKey        int            NULL,
        ShipMethKey        int            NULL,
        ShipZoneKey        int            NULL,
        ExtAmt             decimal(15,3)  NULL,
        FreightAmt         decimal(15,3)  NULL,
        Quantity           decimal(16,8)  NULL,
        GLAcctKey          int            NULL,
        POLineDistKey      int            NULL,
        RcvrLineDistKey    int            NULL
    );

    --------------------------------------------------------
    -- Sales-tax work tables expected by Sage API
    --------------------------------------------------------

    CREATE TABLE #tciSTaxDelete
    (
        STaxTranKey int      NOT NULL,
        NeedsDelete smallint NOT NULL
    );

    CREATE TABLE #tciSTaxTran
    (
        STaxTranKey   int NULL,
        STaxSchdKey   int NULL,
        NeedInsert    int NULL,
        UpdateCounter int NULL
    );

    SELECT TOP (0) *
    INTO #tciSTaxCodeTran
    FROM dbo.tciSTaxCodeTran;

    CREATE TABLE #tciSTaxLine
    (
        HeaderKey       int           NULL,
        LineKey         int           NULL,
        STaxClassKey    int           NULL,
        FrtSTaxClassKey int           NULL,
        ShipMethKey     int           NULL,
        STaxSchdKey     int           NULL,
        Quantity        decimal(16,8) NULL,
        ExtAmt          decimal(15,3) NULL,
        FreightAmt      decimal(15,3) NULL,
        ShipToAddrKey   int           NULL,
        CompanyID       varchar(3)    NULL,
        STaxTranKey     int           NULL,
        RoundDigitsNC   int           NULL
    );

    CREATE TABLE #STaxSums
    (
        STaxTranKey       int           NULL,
        HeaderKey         int           NULL,
        STaxCodeKey       decimal(15,3) NULL,
        ActNonRecoverAmt  decimal(15,3) NULL,
        ActSTaxAmt        decimal(15,3) NULL,
        ActUseTaxAmt      decimal(15,3) NULL,
        CalcNonRecoverAmt decimal(15,3) NULL,
        CalcSTaxAmt       decimal(15,3) NULL,
        CalcUseTaxAmt     decimal(15,3) NULL,
        ExmptAmt          decimal(15,3) NULL,
        STaxExmptNo       decimal(15,3) NULL,
        SubjFreightAmt    decimal(15,3) NULL,
        SubjSales         decimal(15,3) NULL,
        SubjSTaxAmt       decimal(15,3) NULL
    );

    CREATE TABLE #tciSTaxExmpt
    (
        STaxCodeKey   int         NOT NULL,
        ShipToAddrKey int         NULL,
        CompanyID     varchar(3)  NULL,
        ExmptNo       varchar(15) NULL
    );

    CREATE TABLE #tciSTaxCodeLineCalc
    (
        LineKey           int           NOT NULL,
        STaxCodeKey       int           NOT NULL,
        STaxCodeID        varchar(15)   NULL,
        STaxExmptNo       varchar(15)   NULL,
        NonRecoverAmt     decimal(18,6) NULL,
        UseTaxAmt         decimal(18,6) NULL,
        STaxAmt           decimal(18,6) NULL,
        Rate              decimal(12,6) NULL,
        Exempt            smallint      NULL,
        NonRecoverPct     decimal(5,4)  NULL,
        UseTax            smallint      NULL,
        NonTaxable        smallint      NULL,
        ExmptAmt          decimal(18,6) NULL,
        SubjSalesAmt      decimal(15,3) NULL,
        SubjFreightAmt    decimal(15,3) NULL,
        SubjSTaxAmt       decimal(18,6) NULL,
        HoldSubjSTaxAmt   decimal(18,6) NULL,
        CalcBase          smallint      NULL,
        TempNonTaxable    smallint      NULL,
        Taxable           smallint      NULL,
        SeqNo             int           NULL
    );

    -- Some CI tax routines use the non-line version.
    CREATE TABLE #tciSTaxCodeCalc
    (
        STaxCodeKey       int           NOT NULL,
        STaxCodeID        varchar(15)   NULL,
        STaxExmptNo       varchar(15)   NULL,
        NonRecoverAmt     decimal(18,6) NULL,
        UseTaxAmt         decimal(18,6) NULL,
        STaxAmt           decimal(18,6) NULL,
        Rate              decimal(12,6) NULL,
        Exempt            smallint      NULL,
        NonRecoverPct     decimal(5,4)  NULL,
        UseTax            smallint      NULL,
        NonTaxable        smallint      NULL,
        ExmptAmt          decimal(18,6) NULL,
        SubjSalesAmt      decimal(15,3) NULL,
        SubjFreightAmt    decimal(15,3) NULL,
        SubjSTaxAmt       decimal(18,6) NULL,
        HoldSubjSTaxAmt   decimal(18,6) NULL,
        CalcBase          smallint      NULL,
        TempNonTaxable    smallint      NULL,
        Taxable           smallint      NULL,
        SeqNo             int           NULL
    );

    CREATE TABLE #HeaderKeyNeeded
    (
        HeaderKey   int NULL,
        STaxTranKey int NULL
    );

    CREATE TABLE #AddrKeys
    (
        AddrKey int NULL
    );

    CREATE TABLE #UnmaskedGLAcct
    (
        GLAcctNo          varchar(100) NOT NULL,
        AcctMaskDelimiter varchar(1)   NULL,
        GLAcctKey         int          NULL,
        UnMaskedGLAcctNo  varchar(200) NULL
    );

    --------------------------------------------------------
    -- 1. CREATE NATIVE PO RECEIPT-OF-INVOICE BATCH
    --------------------------------------------------------

    SET @RetVal  = 0;
    SET @BatchKey = NULL;
    SET @Spid = NULL;

    EXEC dbo.spapSetupBatch
         @_iBatchNo         = NULL,
         @_iBatchKey        = NULL,
         @_iBatchCmnt       = 'Process Receipt Of Invoice',
         @_iBatchOvrdSegVal = NULL,
         @_iBatchType       = 1102,
         @_iInterCompany    = 0,
         @_iInterCoBatchKey = NULL,
         @_iOrigUserID      = @UserID,
         @_iPostDate        = @PostDate,
         @_iSourceCompanyID = @CompanyID,
         @_iTranCtrl        = @TranAmt,
         @_iHold            = 0,
         @_iHoldReason      = NULL,
         @_iPrivate         = 0,
         @_iCashAcctKey     = NULL,
         @_iCashAcctID      = NULL,
         @_iImportLogKey    = NULL,
         @_iLogSuccessful   = 1,
         @_oRetVal          = @RetVal OUTPUT,
         @_oBatchKey        = @BatchKey OUTPUT,
         @_oSpid            = @Spid OUTPUT;

    SELECT
        'spapSetupBatch' AS Step,
        @RetVal AS RetVal,
        @BatchKey AS BatchKey,
        @Spid AS Spid;

    IF ISNULL(@RetVal,0) NOT IN (1,2)
        THROW 50100, 'spapSetupBatch failed.', 1;

    IF @BatchKey IS NULL
        THROW 50101, 'spapSetupBatch did not return a BatchKey.', 1;

    --------------------------------------------------------
    -- 2. GET NATIVE VOUCHER DEFAULTS
    --------------------------------------------------------

    SET @VouchKey = NULL;
    SET @TranID   = NULL;
    SET @SmallRetVal = 0;
    SET @UniqueID = 'QUADIENT-' + CONVERT(varchar(20), @StagingID);

    EXEC dbo.spapGetVouchDflts
         @_iApplySeqNo           = NULL,
         @_iBatchKey             = @BatchKey,

         @_iRemitToVendAddrKey   = NULL,
         @_iRemitToVendAddrID    = NULL,
         @_iRemitToCopyKey       = NULL,
         @_iRemitToCopyID        = NULL,
         @_iRemitToAddrName      = NULL,
         @_iRTAddrLine1          = NULL,
         @_iRTAddrLine2          = NULL,
         @_iRTAddrLine3          = NULL,
         @_iRTAddrLine4          = NULL,
         @_iRTAddrLine5          = NULL,
         @_iRTCity               = NULL,
         @_iRTState              = NULL,
         @_iRTCountryID          = NULL,
         @_iRTPostalCode         = NULL,

         @_iCashAcctKey          = NULL,
         @_iCashAcctID           = NULL,
         @_iCntcKey              = NULL,
         @_iCntcName             = NULL,

         @_iCurrExchRate         = NULL,
         @_iCurrExchSchdKey      = NULL,
         @_iCurrExchSchdID       = NULL,
         @_iCurrID               = NULL,

         @_iHoldPmt              = 0,

         @_iVendClassKey         = NULL,
         @_iVendClassID          = NULL,
         @_iVendKey              = @VendKey,
         @_iVendID               = @VendorID,

         @_iFOBKey               = NULL,
         @_iFOBID                = NULL,
         @_iImportLogKey         = NULL,
         @_iPmtTermsKey          = NULL,
         @_iPmtTermsID           = NULL,
         @_iReasonCodeKey        = NULL,
         @_iReasonCodeID         = NULL,

         @_iFreightAmt           = @FreightAmt,
         @_iSeparateCheck        = 0,

         @_iShipMethKey          = NULL,
         @_iShipMethID           = NULL,

         @_iPurchFromVendAddrKey = @PurchVendAddrKey,
         @_iPurchFromVendAddrID  = NULL,
         @_iPurchToCopyKey       = NULL,
         @_iPurchToCopyID        = NULL,

         @_iPurchFromAddrName    = NULL,
         @_iPurchAddrLine1       = NULL,
         @_iPurchAddrLine2       = NULL,
         @_iPurchAddrLine3       = NULL,
         @_iPurchAddrLine4       = NULL,
         @_iPurchAddrLine5       = NULL,
         @_iPurchCity            = NULL,
         @_iPurchState           = NULL,
         @_iPurchCountryID       = NULL,
         @_iPurchPostalCode      = NULL,

         @_iShipZoneKey          = NULL,
         @_iShipZoneID           = NULL,

         @_iTranCmnt             = 'Quadient 3-way native test',
         @_iTranDate             = @InvoiceDate,
         @_iTranNo               = @TranNo,
         @_iTranType             = 401,
         @_iUniqueID             = @UniqueID,

         @_iDefaultIfNull        = 1,
         @_iUserID               = @UserID,

         @_iV1099Box             = NULL,
         @_iV1099BoxText         = NULL,
         @_iV1099Form            = NULL,
         @_iRetntAmt             = 0,
         @_iVouchNo              = NULL,
         @_iInvcRcptDate         = @InvoiceDate,

         @_oVouchKey             = @VouchKey OUTPUT,
         @_oTranID               = @TranID OUTPUT,
         @_oRetVal               = @SmallRetVal OUTPUT;

    SELECT
        'spapGetVouchDflts' AS Step,
        @SmallRetVal AS RetVal,
        @VouchKey AS VoucherKey,
        @TranID AS TranID;

    IF ISNULL(@SmallRetVal,0) NOT IN (1,2)
        THROW 50110, 'spapGetVouchDflts failed.', 1;

    IF @VouchKey IS NULL
        THROW 50111, 'spapGetVouchDflts did not return a VoucherKey.', 1;

    --------------------------------------------------------
    -- Show Sage defaults before detail creation.
    --------------------------------------------------------

    SELECT
        'API defaults' AS ResultType,
        *
    FROM #tapAPIValid;

    -- Confirm Sage defaulted the vendor-specific purchase address
    -- and sales-tax schedule resolved from the staged vendor context.

    IF NOT EXISTS
    (
        SELECT 1
        FROM #tapAPIValid
        WHERE STaxSchdKey = @ExpectedSTaxSchdKey
          AND PurchFromVendAddrKey = @PurchVendAddrKey
    )
        THROW 50112,
            'Sage did not use the expected vendor purchase address / tax schedule.',
            1;

--------------------------------------------------------
-- 3. CREATE ALL NATIVE VOUCHER DETAIL LINES
--------------------------------------------------------

DECLARE
    @CurrentRowNo         int,
    @CurrentLineNumber    int,
    @CurrentLineType      varchar(30),

    @CurrentItemKey       int,
    @CurrentDescription   varchar(40),
    @CurrentQuantity      decimal(16,8),
    @CurrentUnitCost      decimal(15,5),
    @CurrentLineAmount    decimal(15,3),

    @CurrentPOKey         int,
    @CurrentPONumber      varchar(10),
    @CurrentPOLineKey     int,
    @CurrentPOLineNumber  int,
    @CurrentRcvrLineKey   int,

    @CurrentUnitMeasKey   int,

    @CurrentGLAcctKey     int,
    @CurrentGLAcctNo      varchar(100),

    @CurrentSTaxClassKey  int,
    @CurrentSTaxClassID   varchar(15),

    @CurrentMatchStatus   smallint,

    @LineRet              int;


SET @CurrentRowNo = 1;


WHILE EXISTS
(
    SELECT 1
    FROM @InvoiceLines
    WHERE RowNo = @CurrentRowNo
)
BEGIN

    --------------------------------------------------------
    -- Load next resolved staging line
    --------------------------------------------------------

    SELECT
        @CurrentLineNumber   = LineNumber,
        @CurrentLineType     = LineType,

        @CurrentItemKey      = ItemKey,
        @CurrentDescription  = Description,
        @CurrentQuantity     = Quantity,
        @CurrentUnitCost     = UnitCost,
        @CurrentLineAmount   = LineAmount,

        @CurrentPOKey        = POKey,
        @CurrentPONumber     = PONumber,
        @CurrentPOLineKey    = POLineKey,
        @CurrentPOLineNumber = POLineNumber,
        @CurrentRcvrLineKey  = RcvrLineKey,

        @CurrentUnitMeasKey  = UnitMeasKey,

        @CurrentGLAcctKey    = GLAcctKey,
        @CurrentGLAcctNo     = GLAcctNo,

        @CurrentSTaxClassKey = STaxClassKey,
        @CurrentSTaxClassID  = STaxClassID,

        @CurrentMatchStatus  = MatchStatus

    FROM @InvoiceLines
    WHERE RowNo = @CurrentRowNo;


    SET @LineRet = 0;


    --------------------------------------------------------
    -- Feed this line through Sage's native voucher-detail
    -- routine.
    --------------------------------------------------------

    EXEC dbo.spapGetVouchDtl
         @_iTargetCompanyID = @CompanyID,
         @_iVouchKey        = @VouchKey,
         @_iCmntOnly        = 0,

         @_iDescription     = @CurrentDescription,
         @_iExtAmt          = @CurrentLineAmount,
         @_iRetntAmt        = 0,
         @_iRetntRate       = NULL,
         @_iExtCmnt         = NULL,

         @_iItemKey         = @CurrentItemKey,
         @_iItemID          = NULL,
         @_iQuantity        = @CurrentQuantity,

         @_iGLAcctKey       = @CurrentGLAcctKey,
         @_iGLAcctNo        = @CurrentGLAcctNo,

         @_iSTaxClassKey    = @CurrentSTaxClassKey,
         @_iSTaxClassID     = @CurrentSTaxClassID,

         @_iUnitCost        = @CurrentUnitCost,
         @_iUnitMeasKey     = @CurrentUnitMeasKey,
         @_iUnitMeasID      = NULL,

         @_iAcctRefKey      = NULL,
         @_iAcctRefCode     = NULL,

         @_iFOBKey          = NULL,
         @_iFOBID           = NULL,

         -- SHIPPING / other additional charges remain normal
         -- voucher detail, not header freight.
         @_iFreightAmt      = 0,

         @_iShipMethKey     = NULL,
         @_iShipMethID      = NULL,
         @_iShipZoneKey     = NULL,
         @_iShipZoneID      = NULL,

         @_iSTaxSchdKey     = @ExpectedSTaxSchdKey,
         @_iSTaxSchdID      = @ExpectedSTaxSchdID,

         @_iDefaultIfNull   = 1,
         @_iPerformOverride = 0,
         @_iSpid            = @Spid,
         @_iCommissionFlag  = 0,

         @_iPOKey           = @CurrentPOKey,
         @_iPONo            = @CurrentPONumber,
         @_iPOLineKey       = @CurrentPOLineKey,
         @_iPOLineNo        = @CurrentPOLineNumber,
         @_iRcvrLineKey     = @CurrentRcvrLineKey,

         @_iMatchStatus     = @CurrentMatchStatus,
         @_iReturnType      = 0,

         @_oRetVal          = @LineRet OUTPUT;


    SELECT
        'STAGING-DRIVEN DETAIL LINE' AS Step,
        @CurrentRowNo AS RowNo,
        @CurrentLineNumber AS LineNumber,
        @CurrentLineType AS LineType,
        @CurrentDescription AS Description,
        @CurrentLineAmount AS ExtAmt,
        @CurrentPOLineKey AS POLineKey,
        @CurrentRcvrLineKey AS RcvrLineKey,
        @CurrentMatchStatus AS MatchStatus,
        @LineRet AS RetVal;


    IF ISNULL(@LineRet, 0) NOT IN (1,2)
    BEGIN
        DECLARE @LineFailureMessage varchar(255);

        SET @LineFailureMessage =
            'spapGetVouchDtl failed for staged detail row '
            + CONVERT(varchar(20), @CurrentRowNo)
            + ', line '
            + ISNULL(CONVERT(varchar(20), @CurrentLineNumber), 'NULL')
            + ', type '
            + ISNULL(@CurrentLineType, 'NULL')
            + '.';

        THROW 50121,
            @LineFailureMessage,
            1;
    END;


    SET @CurrentRowNo = @CurrentRowNo + 1;

END;
    -- Inspect API work rows BEFORE creating real voucher.
    --------------------------------------------------------

    SELECT
        'TEMP DETAIL BEFORE CREATE' AS ResultType,
        *
    FROM #tapVoucherDetl
    ORDER BY SeqNo;

    SELECT
        'TEMP DISTRIBUTION BEFORE CREATE' AS ResultType,
        *
    FROM #tapVoucherLineDist
    ORDER BY VoucherLineKey;

    SELECT
        'TEMP TAX HEADER' AS ResultType,
        *
    FROM #tciSTaxTran;

    SELECT
        'TEMP TAX DETAIL' AS ResultType,
        *
    FROM #tciSTaxCodeTran;


    --------------------------------------------------------
    -- Sanity check purchase total generated from lines
    --------------------------------------------------------

    IF
    (
        SELECT ISNULL(SUM(ExtAmt), 0)
        FROM #tapVoucherDetl
    ) <> @PurchAmt
        THROW 50130,
            'Temporary voucher detail does not equal the staged purchase amount.',
            1;
    
    IF EXISTS
    (
        SELECT 1
        FROM #tapVoucherLineDist
        WHERE STaxSchdKey <> @ExpectedSTaxSchdKey
           OR STaxSchdKey IS NULL
    )
        THROW 50122,
            'Voucher detail did not use the expected vendor tax schedule.',
            1;

IF @InvoiceSTaxAmt = 0
   AND EXISTS
   (
       SELECT 1
       FROM #tciSTaxCodeTran
       WHERE ISNULL(ActSTaxAmt, 0) <> 0
          OR ISNULL(CalcSTaxAmt, 0) <> 0
   )
    THROW 50123,
        'Sage calculated sales tax when the staged invoice expected zero sales tax.',
        1;

    --------------------------------------------------------
    -- 4. CREATE REAL PENDING VOUCHER
    --------------------------------------------------------

    SET @RetVal = 0;

    EXEC dbo.spapCreatePendVoucher
         @_iVouchKey  = @VouchKey,
         @_iVendKey   = @VendKey,
         @_iDueDate   = NULL,
         @_iDiscAmt   = 0,
         @_iDiscDate  = NULL,
         @_iExemptKey = @PurchVendAddrKey,
         @_iRetntAmt  = 0,
         @_iSTaxAmt   = @InvoiceSTaxAmt,
         @_iPurchAmt  = @PurchAmt,
         @_iTranAmt   = @TranAmt,
         @_oRetVal    = @RetVal OUTPUT;

    SELECT
        'spapCreatePendVoucher' AS Step,
        @RetVal AS RetVal,
        @BatchKey AS BatchKey,
        @VouchKey AS VoucherKey;

    IF ISNULL(@RetVal,0) NOT IN (1,2)
        THROW 50140,
            'spapCreatePendVoucher failed.',
            1;

    --------------------------------------------------------
    -- Populate UnitCostExact for native PO matching
    --
    -- spapCreatePendVoucher writes UnitCost but does not
    -- populate UnitCostExact.  sppoMatchVouchBatch uses
    -- UnitCostExact during its UOM conversion/matching logic.
    --------------------------------------------------------


DECLARE @ExpectedDetailCount int;

SELECT
    @ExpectedDetailCount = COUNT(*)
FROM @InvoiceLines;


UPDATE vd
SET vd.UnitCostExact =
    CONVERT(decimal(25,13), vd.UnitCost)
FROM dbo.tapVoucherDetl vd
WHERE vd.VoucherKey = @VouchKey;


IF @@ROWCOUNT <> @ExpectedDetailCount
    THROW 50140,
        'UnitCostExact was not updated on every voucher detail line.',
        1;

    SELECT
        'UNIT COST EXACT CHECK' AS ResultType,
        VoucherLineKey,
        SeqNo,
        POLineKey,
        ExtAmt,
        UnitCost,
        UnitCostExact
    FROM dbo.tapVoucherDetl
    WHERE VoucherKey = @VouchKey
    ORDER BY SeqNo;

    --------------------------------------------------------
    -- 5. BUILD PO/VOUCHER LINK USING NATIVE SAGE ROUTINE
    --------------------------------------------------------

    SET @RetVal = 0;

    EXEC dbo.sppoUpdatePOVchLnk
         @_iVoucherKey = @VouchKey,
         @_oRetVal     = @RetVal OUTPUT;

    SELECT
        'sppoUpdatePOVchLnk' AS Step,
        @RetVal AS RetVal;

    SELECT
        'PO LINK CHECK' AS ResultType,
        *
    FROM dbo.tpoPurchOrdVouch
    WHERE VoucherKey = @VouchKey;

    IF NOT EXISTS
    (
        SELECT 1
        FROM dbo.tpoPurchOrdVouch
        WHERE VoucherKey = @VouchKey
          AND POKey = @POKey
    )
        THROW 50150,
            'sppoUpdatePOVchLnk did not create the expected PO/Voucher link.',
            1;


    --------------------------------------------------------
    -- Inspect voucher BEFORE matching
    --------------------------------------------------------

    SELECT
        'PENDING HEADER BEFORE MATCH' AS ResultType,
        pv.*
    FROM dbo.tapPendVoucher pv
    WHERE pv.VoucherKey = @VouchKey;

    SELECT
        'DETAIL BEFORE MATCH' AS ResultType,
        vd.*
    FROM dbo.tapVoucherDetl vd
    WHERE vd.VoucherKey = @VouchKey
    ORDER BY vd.SeqNo;

    SELECT
        'LINE DIST BEFORE MATCH' AS ResultType,
        vld.*
    FROM dbo.tapVoucherLineDist vld
    JOIN dbo.tapVoucherDetl vd
        ON vd.VoucherLineKey = vld.VoucherLineKey
    WHERE vd.VoucherKey = @VouchKey
    ORDER BY vd.SeqNo;

    SELECT
        'PO LINK BEFORE MATCH' AS ResultType,
        pov.*
    FROM dbo.tpoPurchOrdVouch pov
    WHERE pov.VoucherKey = @VouchKey;

    SELECT
        'RECEIVER HEADER LINK BEFORE MATCH' AS ResultType,
        vr.*
    FROM dbo.tpoVoucherRcvr vr
    WHERE vr.VoucherKey = @VouchKey;

    SELECT
        'RECEIVER LINE LINK BEFORE MATCH' AS ResultType,
        rvl.*
    FROM dbo.tpoRcvrVouchLine rvl
    JOIN dbo.tapVoucherDetl vd
        ON vd.VoucherLineKey = rvl.VoucherLineKey
    WHERE vd.VoucherKey = @VouchKey;

    SELECT
        'RECEIVER DIST LINK BEFORE MATCH' AS ResultType,
        rvld.*
    FROM dbo.tpoRcvrVouchLnDist rvld
    JOIN dbo.tapVoucherLineDist vld
        ON vld.VoucherLineDistKey = rvld.VoucherLineDistKey
    JOIN dbo.tapVoucherDetl vd
        ON vd.VoucherLineKey = vld.VoucherLineKey
    WHERE vd.VoucherKey = @VouchKey;


    --------------------------------------------------------
    -- 6. SAGE PO MATCH WORK TABLE
    --------------------------------------------------------

    CREATE TABLE #tpoVouchMatchWrk
    (
        SeqNo                 int            NULL,
        BatchKey              int            NULL,

        AllowdLineOverAmt     decimal(15,3)  NULL,
        AllowdLineOverPct     decimal(12,6)  NULL,
        AllowdLineUnderAmt    decimal(15,3)  NULL,
        AllowdLineUnderPct    decimal(12,6)  NULL,

        AllowdQtyOver         decimal(16,8)  NULL,
        AllowdQtyOverPct      decimal(12,6)  NULL,

        AllowdTotalOverAmt    decimal(15,3)  NULL,
        AllowdTotalOverPct    decimal(12,6)  NULL,

        AllowdUCOverAmt       decimal(15,5)  NULL,
        AllowdUCOverPct       decimal(12,6)  NULL,
        AllowdUCUnderAmt      decimal(15,5)  NULL,
        AllowdUCUnderPct      decimal(12,6)  NULL,

        Description           varchar(40)    NULL,
        HdrMatchTolKey        int            NULL,
        ItemID                varchar(30)    NULL,

        LineFailureAmt        decimal(15,3)  NULL,
        LineMatchTolKey       int            NULL,
        LineOverAction        smallint       NULL,
        LineUnderAction       smallint       NULL,

        MatchStatus           smallint       NULL,
        MatchStatusDesc       varchar(80)    NULL,

        POCurrExchRate        float          NULL,
        POCurrID              varchar(3)     NULL,
        POExtAmt              decimal(15,3)  NULL,
        POExtAmtHC            decimal(15,3)  NULL,
        POFailureAmt          decimal(15,3)  NULL,
        POHoldStatus          smallint       NULL,

        POKey                 int            NULL,
        POLineKey             int            NULL,
        POLineNo              smallint       NULL,
        POLineQty             decimal(16,8)  NULL,
        POLineUpdateCtr       int            NULL,

        POTranNoRelChngOrd    varchar(19)    NULL,
        POUnitCost            decimal(15,5)  NULL,
        POUnitCostHC          decimal(15,5)  NULL,
        POUnitMeasKey         int            NULL,
        POUpdateCounter       int            NULL,

        PurchAmt              decimal(15,3)  NULL,
        PurchAmtHC            decimal(15,3)  NULL,
        PurchAmtDiff          decimal(15,3)  NULL,

        QtyFailure            decimal(16,8)  NULL,
        QtyOverAction         smallint       NULL,
        TotalOverAction       smallint       NULL,

        UCDifference          decimal(15,5)  NULL,
        UCFailureAmt          decimal(15,5)  NULL,
        UCOverAction          smallint       NULL,
        UCUnderAction         smallint       NULL,

        VCurrExchRate         float          NULL,
        VCurrID               varchar(3)     NULL,
        VendID                varchar(12)    NULL,

        VoucherLineKey        int            NULL,
        VExtAmt               decimal(15,3)  NULL,
        VExtAmtHC             decimal(15,3)  NULL,
        VoucherKey            int            NULL,
        VouchNo               varchar(10)    NULL,
        VQty                  decimal(16,8)  NULL,
        VTranNo               varchar(15)    NULL,
        VUnitCost             decimal(15,5)  NULL,
        VUnitCostHC           decimal(15,5)  NULL,
        VUnitMeasKey          int            NULL,

        VUnitCostExact        decimal(25,13) NULL,
        VUnitCostExactHC      decimal(25,13) NULL
    );


    --------------------------------------------------------
    -- 7. RUN NATIVE SAGE MATCHING
    --------------------------------------------------------

    SET @MatchRetVal = 0;

    EXEC dbo.sppoMatchVouchBatch
         @BatchKey,
         @CompanyID,
         1033,
         @MatchRetVal OUTPUT;

    SELECT
        'sppoMatchVouchBatch' AS Step,
        @MatchRetVal AS RetVal;


    --------------------------------------------------------
    -- 8. CLEAN UP / RELEASE THE AP BATCH BEFORE CONVERSION
    --
    -- spapSetupBatch places a shared logical lock on the batch and
    -- sets tciBatchLog.Status = 1 (In Use).  spapBatchCleanup must
    -- run in this SAME SQL session while #tapAPIValid still exists
    -- and while the active batch row is still in tapBatch.
    --
    -- For this balanced, non-held batch, Sage should reset Status
    -- to 4 (Balanced) and remove the logical BATCH lock.
    --------------------------------------------------------

    SET @RetVal = 0;

SELECT
    'BEFORE CLEANUP' AS DiagnosticStep,
    bl.BatchKey,
    bl.BatchID,
    bl.Status AS BatchStatus,
    bl.BatchTotal,
    b.TranCtrl,
    pv.VoucherKey,
    pv.PurchAmt,
    pv.STaxAmt,
    pv.TranAmt,
    pv.STaxTranKey
FROM dbo.tciBatchLog bl
LEFT JOIN dbo.tapBatch b
    ON b.BatchKey = bl.BatchKey
LEFT JOIN dbo.tapPendVoucher pv
    ON pv.BatchKey = bl.BatchKey
WHERE bl.BatchKey = @BatchKey;

SELECT
    'TAX DETAIL BEFORE CLEANUP' AS DiagnosticStep,
    ct.STaxCodeKey,
    ct.ActSTaxAmt,
    ct.CalcSTaxAmt,
    ct.SubjSales,
    ct.SubjSTaxAmt
FROM dbo.tciSTaxCodeTran ct
JOIN dbo.tapPendVoucher pv
    ON pv.STaxTranKey = ct.STaxTranKey
WHERE pv.VoucherKey = @VouchKey;

    EXEC dbo.spapBatchCleanup
         @_iBatchKey = @BatchKey,
         @_oRetVal   = @RetVal OUTPUT;

    SELECT
        'spapBatchCleanup' AS Step,
        @RetVal AS RetVal;

    IF ISNULL(@RetVal,0) <> 1
        THROW 50158, 'spapBatchCleanup failed before PO batch conversion.', 1;

    --------------------------------------------------------
    -- Diagnose batch totals/status after cleanup
    --------------------------------------------------------

    SELECT
        'BATCH STATUS AFTER CLEANUP' AS ResultType,
        bl.BatchKey,
        bl.BatchID,
        bl.Status,
        bl.PostStatus,
        bl.BatchTotal,
        b.TranCtrl,
        b.Hold,
        b.PostDate
    FROM dbo.tciBatchLog bl
    LEFT JOIN dbo.tapBatch b
        ON b.BatchKey = bl.BatchKey
    WHERE bl.BatchKey = @BatchKey;

    IF NOT EXISTS
    (
        SELECT 1
        FROM dbo.tciBatchLog
        WHERE BatchKey = @BatchKey
          AND Status = 4
    )
        THROW 50159,
            'Batch cleanup did not leave the batch in Balanced status (4).',
            1;

    DECLARE
        @ShareLockCount int = 0,
        @ExclusiveLockCount int = 0,
        @BatchLockEntity varchar(64) = 'BATCH' + CONVERT(varchar(20), @BatchKey);

    EXEC dbo.spCountLogical
         @BatchLockEntity,
         @ShareLockCount OUTPUT,
         @ExclusiveLockCount OUTPUT;

    SELECT
        'BATCH CLEANUP CHECK' AS ResultType,
        @BatchKey AS BatchKey,
        @ShareLockCount AS ShareLockCount,
        @ExclusiveLockCount AS ExclusiveLockCount,
        bl.Status,
        bl.PostStatus
    FROM dbo.tciBatchLog bl
    WHERE bl.BatchKey = @BatchKey;

    IF ISNULL(@ShareLockCount,0) <> 0
       OR ISNULL(@ExclusiveLockCount,0) <> 0
        THROW 50157, 'Logical batch lock still exists after spapBatchCleanup.', 1;


    --------------------------------------------------------
    -- 9. CONVERT AP BATCH OWNERSHIP TO PO RECEIPT-OF-INVOICE
    --
    -- spapSetupBatch creates the batch in tapBatch and initially gives
    -- it an APVO batch number.  Sage's PO Receipt-of-Invoice UI expects
    -- the active batch in tpoBatch with a POVO batch number.
    --------------------------------------------------------

    IF NOT EXISTS
    (
        SELECT 1
        FROM dbo.tapBatch
        WHERE BatchKey = @BatchKey
    )
        THROW 50160, 'Expected active batch row in tapBatch before PO conversion.', 1;

    INSERT INTO dbo.tpoBatch
    (
        BatchKey,
        BatchCmnt,
        BatchOvrdSegKey,
        BatchOvrdSegValue,
        CreateDate,
        CreateType,
        Hold,
        HoldReason,
        InterCompany,
        InterCompBatchKey,
        OrigUserID,
        PostDate,
        Private,
        TranCtrl,
        UpdateCounter
    )
    SELECT
        BatchKey,
        BatchCmnt,
        BatchOvrdSegKey,
        BatchOvrdSegValue,
        CreateDate,
        CreateType,
        Hold,
        HoldReason,
        InterCompany,
        InterCompBatchKey,
        OrigUserID,
        PostDate,
        Private,
        TranCtrl,
        UpdateCounter
    FROM dbo.tapBatch
    WHERE BatchKey = @BatchKey;

    IF @@ROWCOUNT <> 1
        THROW 50161, 'Expected exactly one tapBatch row to copy to tpoBatch.', 1;

    DELETE FROM dbo.tapBatch
    WHERE BatchKey = @BatchKey;

    IF @@ROWCOUNT <> 1
        THROW 50162, 'Expected exactly one tapBatch row to delete after PO conversion.', 1;

    --------------------------------------------------------
    -- Allocate a proper PO-voucher batch number.
    -- spGetNextBatchNo creates a temporary tciBatchLog row; delete
    -- that temporary row and apply its number to our real batch.
    --------------------------------------------------------

    SET @TempBatchKey  = NULL;
    SET @POBatchNo     = NULL;
    SET @POBatchRetVal = 0;

    EXEC dbo.spGetNextBatchNo
         @CompanyID,
         1102,
         @UserID,
         11,
         @TempBatchKey OUTPUT,
         @POBatchNo OUTPUT,
         @POBatchRetVal OUTPUT;

    SELECT
        'spGetNextBatchNo' AS Step,
        @POBatchRetVal AS RetVal,
        @TempBatchKey AS TempBatchKey,
        @POBatchNo AS POBatchNo;

    IF ISNULL(@POBatchRetVal,0) <> 1
        THROW 50163, 'spGetNextBatchNo failed for PO voucher batch.', 1;

    IF @TempBatchKey IS NULL OR @POBatchNo IS NULL
        THROW 50164, 'spGetNextBatchNo did not return the expected PO batch values.', 1;

    DELETE FROM dbo.tciBatchLog
    WHERE BatchKey = @TempBatchKey;

    IF @@ROWCOUNT <> 1
        THROW 50165, 'Expected exactly one temporary tciBatchLog row to delete.', 1;

    UPDATE dbo.tciBatchLog
    SET
        BatchType = 1102,
        BatchID   = 'POVO-' + RIGHT('0000000' + CAST(@POBatchNo AS varchar(20)), 7),
        BatchNo   = @POBatchNo
    WHERE BatchKey = @BatchKey;

    IF @@ROWCOUNT <> 1
        THROW 50166, 'Expected exactly one real tciBatchLog row to convert to POVO.', 1;

    SELECT
        'PO BATCH CONVERSION CHECK' AS ResultType,
        bl.BatchKey,
        bl.BatchID,
        bl.BatchNo,
        bl.BatchType,
        bl.SourceCompanyID,
        bl.OrigUserID,
        bl.Status,
        bl.PostStatus,
        pb.PostDate,
        pb.TranCtrl,
        pb.Private,
        pb.Hold
    FROM dbo.tciBatchLog bl
    JOIN dbo.tpoBatch pb
        ON pb.BatchKey = bl.BatchKey
    WHERE bl.BatchKey = @BatchKey;


    --------------------------------------------------------
    -- 10. RESULTS FROM SAGE MATCH ENGINE
    --------------------------------------------------------

    SELECT
        'MATCH WORK' AS ResultType,
        *
    FROM #tpoVouchMatchWrk
    ORDER BY SeqNo;

    SELECT
        'DETAIL AFTER MATCH' AS ResultType,
        vd.VoucherKey,
        vd.VoucherLineKey,
        vd.SeqNo,
        vd.Description,
        vd.ExtAmt,
        vd.ItemKey,
        vd.POLineKey,
        vd.RcvrLineKey,
        vd.MatchStatus,
        vd.UnitCost,
        vd.UnitCostExact,
        vd.UnitMeasKey,
        vd.STaxClassKey
    FROM dbo.tapVoucherDetl vd
    WHERE vd.VoucherKey = @VouchKey
    ORDER BY vd.SeqNo;


    --------------------------------------------------------
    -- 11. FINAL HEADER / TAX CHECK
    --------------------------------------------------------

    SELECT
        'FINAL PENDING HEADER' AS ResultType,
        pv.VoucherKey,
        pv.BatchKey,
        pv.CompanyID,
        pv.VendKey,
        pv.TranNo,
        pv.TranID,
        pv.VouchNo,
        pv.TranType,
        pv.PurchAmt,
        pv.FreightAmt,
        pv.STaxAmt,
        pv.TranAmt,
        pv.STaxTranKey
    FROM dbo.tapPendVoucher pv
    WHERE pv.VoucherKey = @VouchKey;


--------------------------------------------------------
-- 12. Verify receiver quantities appear consumed INSIDE
-- this transaction for all PO-matched receiver lines.
--------------------------------------------------------

SELECT
    il.LineNumber,
    il.RcvrLineKey,
    rld.RcvrLineDistKey,
    rld.QtyRcvd,
    ISNULL(SUM(rvld.QtyInvcd), 0) AS QtyInvcdInsideTest,
    rld.QtyRcvd
        - ISNULL(SUM(rvld.QtyInvcd), 0) AS QtyRemainingInsideTest
FROM @InvoiceLines il
JOIN dbo.tpoRcvrLineDist rld
    ON rld.RcvrLineKey = il.RcvrLineKey
LEFT JOIN dbo.tpoRcvrVouchLnDist rvld
    ON rvld.RcvrLineDistKey = rld.RcvrLineDistKey
WHERE il.LineType = 'PO_MATCHED'
GROUP BY
    il.LineNumber,
    il.RcvrLineKey,
    rld.RcvrLineDistKey,
    rld.QtyRcvd
ORDER BY
    il.LineNumber,
    rld.RcvrLineDistKey;


    --------------------------------------------------------
    -- ABSOLUTELY NO AUTOMATIC POSTING.
    --
    -- Commit the pending PO voucher so Accounting can inspect and
    -- post it through Sage's normal Receipt-of-Invoice workflow.
    --------------------------------------------------------

    COMMIT TRAN;

    PRINT '=====================================================';
    PRINT 'TEST COMPLETED AND COMMITTED TO TEST DATABASE.';
    PRINT 'PENDING VOUCHER WAS NOT POSTED.';
    PRINT 'ACCOUNTING SHOULD REVIEW/POST IT IN SAGE.';
    PRINT '=====================================================';


    --------------------------------------------------------
    -- PROVE THE COMMIT / PENDING STATE
    --------------------------------------------------------

    SELECT
        @BatchKey AS TestBatchKey,
        @VouchKey AS TestVoucherKey,
        CASE WHEN EXISTS
        (
            SELECT 1
            FROM dbo.tapPendVoucher
            WHERE VoucherKey = @VouchKey
        )
        THEN 'OK - Pending voucher exists'
        ELSE 'ERROR - Pending voucher missing'
        END AS PendingVoucherCheck,
        CASE WHEN EXISTS
        (
            SELECT 1
            FROM dbo.tpoBatch
            WHERE BatchKey = @BatchKey
        )
        THEN 'OK - PO batch exists'
        ELSE 'ERROR - PO batch missing'
        END AS POBatchCheck,
        CASE WHEN EXISTS
        (
            SELECT 1
            FROM dbo.tapVoucher
            WHERE VoucherKey = @VouchKey
        )
        THEN 'ERROR - Voucher is already posted'
        ELSE 'OK - Voucher is not posted'
        END AS NotPostedCheck;

END TRY

BEGIN CATCH

    DECLARE
        @ErrorNumber  int           = ERROR_NUMBER(),
        @ErrorLine    int           = ERROR_LINE(),
        @ErrorMessage nvarchar(4000)= ERROR_MESSAGE();

    IF @@TRANCOUNT > 0
        ROLLBACK TRAN;

    SELECT
        @ErrorNumber  AS ErrorNumber,
        @ErrorLine    AS ErrorLine,
        @ErrorMessage AS ErrorMessage,
        @@TRANCOUNT   AS TranCountAfterRollback;

    RAISERROR(
        '%s',
        16,
        1,
        @ErrorMessage
    );

END CATCH;
END;
