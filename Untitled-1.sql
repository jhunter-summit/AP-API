

CREATE OR ALTER PROCEDURE dbo.spQuadient_RunPendingAPVoucherImport
    @CompanyID       VARCHAR(3),
    @TranNo          VARCHAR(30),
    @VendID        VARCHAR(12) = NULL,
    @UserID          VARCHAR(5) = 'admin',
    @SessionKey      INT OUTPUT,
    @ResultCode      INT OUTPUT,
    @ResultMessage   VARCHAR(4000) OUTPUT
AS
BEGIN
    SET NOCOUNT ON;

DECLARE @TranHeaderCount INT,
        @HeaderCount INT,
        @SetupStepKey INT = 2200900,
        @DetailCount INT;

SELECT @TranHeaderCount = COUNT(*)
FROM StgPendVoucher
WHERE TranNo = @TranNo;

IF @TranHeaderCount > 1
BEGIN
    SET @ResultCode = -4;
    SET @ResultMessage = 'TranNo exists on more than one StgPendVoucher header. Detail rows cannot be safely isolated by TranNo only.';
    RETURN;
END;

SELECT @HeaderCount = COUNT(*)
FROM StgPendVoucher
WHERE TranNo = @TranNo
  AND VendID = @VendID;

SELECT @DetailCount = COUNT(*)
FROM StgPendInvoiceDetl
WHERE TranNo = @TranNo;

IF @HeaderCount = 0
BEGIN
    SET @ResultCode = -1;
    SET @ResultMessage = 'No matching StgPendVoucher header row found.';
    RETURN;
END;

IF @DetailCount = 0
BEGIN
    SET @ResultCode = -3;
    SET @ResultMessage = 'No matching StgPendInvoiceDetl detail rows found.';
    RETURN;
END;    /*
        Make sure company setup exists.
        This came from Net@Work's script.
    */

    SELECT CompanyID
    FROM tsmCompanySetup
    WHERE CompanyID = @CompanyID;

    IF @@ROWCOUNT = 0
    BEGIN
        INSERT INTO tsmCompanySetup
            (CompanyID, MigrateSourceSystem, MigrateLinkKey, MigrateSourceVersionNo)
        VALUES
            (@CompanyID, 0, NULL, 'Any');
    END;

    /*
        Create or reuse migration session.
        This follows Net@Work's supplied logic.
    */

    SELECT TOP 1 @SessionKey = MigrateSessionKey
    FROM tsmMigrateSession
    WHERE CompanyID = @CompanyID
      AND LastCompProcessTime IS NOT NULL
      AND SetupStepKey = @SetupStepKey
      AND UserID = @UserID
    ORDER BY MigrateSessionKey DESC;

    IF @SessionKey IS NULL
    BEGIN
        EXEC spGetNextSurrogateKey 'tsmMigrateSession', @SessionKey OUTPUT;

        INSERT INTO tsmMigrateSession
            (
                MigrateSessionKey,
                CompanyID,
                LastCompProcessMode,
                LastCompProcessNo,
                LastCompProcessTime,
                SetupStepKey,
                StartTime,
                UserID
            )
        VALUES
            (
                @SessionKey,
                @CompanyID,
                1,
                0,
                NULL,
                @SetupStepKey,
                GETDATE(),
                @UserID
            );
    END
    ELSE
    BEGIN
        UPDATE tsmMigrateSession
        SET LastCompProcessMode = 1,
            LastCompProcessNo = 0,
            LastCompProcessTime = NULL,
            StartTime = GETDATE()
        WHERE MigrateSessionKey = @SessionKey
          AND UserID = @UserID;
    END;

    /*
        Clear old parameter values for this migration session.
    */

    DELETE FROM tsmMigrateStepParamValue
    WHERE MigrateSessionKey = @SessionKey;

    /*
        Assign only this one invoice to the migration session.
    */

    UPDATE StgPendVoucher
    SET SessionKey = @SessionKey,
        ProcessStatus = 0
    WHERE TranNo = @TranNo
      AND VendID = @VendID;

    UPDATE StgPendInvoiceDetl
    SET SessionKey = @SessionKey,
        ProcessStatus = 0
    WHERE TranNo = @TranNo;

    /*
        Run the Sage pending AP voucher insertion procedure.
    */

    DECLARE
        @_oContinue SMALLINT,
        @_iCancel SMALLINT,
        @_iSessionKey INT,
        @_iCompanyID VARCHAR(3),
        @_iRptOption INT,
        @_iPrintWarnings SMALLINT,
        @_iUseStageTable SMALLINT,
        @_oRecsProcessed INT,
        @_oFailedRecs INT,
        @_oTotalRecs INT,
        @_oRetVal INT;

    SELECT
        @_oContinue = 1,
        @_iCancel = 0,
        @_iSessionKey = @SessionKey,
        @_iCompanyID = @CompanyID,
        @_iRptOption = 3,
        @_iPrintWarnings = 0,
        @_iUseStageTable = 1;

    WHILE @_oContinue = 1
    BEGIN
        EXEC spAPapiAPPendInvoiceIns
            @_oContinue OUTPUT,
            @_iCancel,
            @_iSessionKey,
            @_iCompanyID,
            @_iRptOption,
            @_iPrintWarnings,
            @_iUseStageTable,
            @_oRecsProcessed OUTPUT,
            @_oFailedRecs OUTPUT,
            @_oTotalRecs OUTPUT,
            @_oRetVal OUTPUT;
    END;

    UPDATE tsmMigrateSession
    SET LastCompProcessMode = 1,
        LastCompProcessNo = 0,
        LastCompProcessTime = GETDATE()
    WHERE MigrateSessionKey = @SessionKey;

    /*
        Return a simple result to the caller.
    */

    IF ISNULL(@_oFailedRecs, 0) > 0 OR ISNULL(@_oRetVal, 0) <> 0
    BEGIN
        SET @ResultCode = ISNULL(@_oRetVal, -10);

        SELECT TOP 1
            @ResultMessage = LEFT(ISNULL(Comment, 'Sage import failed.'), 4000)
        FROM tdmMigrationLogWrk
        WHERE SessionKey = @SessionKey
        ORDER BY SessionKey DESC;

        IF @ResultMessage IS NULL OR @ResultMessage = ''
            SET @ResultMessage = 'Sage import failed. Check tdmMigrationLogWrk for details.';

        RETURN;
    END;

    SET @ResultCode = 1;
    SET @ResultMessage = 'Pending AP voucher import completed successfully.';
END;
GO