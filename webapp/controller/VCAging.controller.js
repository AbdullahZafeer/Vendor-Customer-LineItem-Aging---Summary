sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/export/Spreadsheet",
    "sap/ui/export/library",
    "sap/m/StandardListItem",
    "sap/m/SelectDialog",
    "sap/m/Token"
], function (
    Controller,
    JSONModel,
    Filter,
    FilterOperator,
    MessageToast,
    MessageBox,
    Spreadsheet,
    exportLibrary,
    StandardListItem,
    SelectDialog,
    Token
) {
    "use strict";

    const EdmType = exportLibrary.EdmType;
    const ENTITY_SET = "/VCAging";
    const CC_VH_SET = "/CompanyCodeVH";

    return Controller.extend("zfivcaginga.controller.VCAging", {

        /* ============================================================== */
        /* Lifecycle                                                       */
        /* ============================================================== */

        onInit: function () {
            this.getView().setModel(new JSONModel({
                lineItems: [],
                summaryRows: [],
                lineCount: 0,
                summaryCount: 0,
                busy: false
            }), "summary");

            // Dropdown source for the Company Code filter.
            this.getView().setModel(new JSONModel({ items: [] }), "ccList");

            this._sActiveTab = "LINE";
            this._setDefaultFilters();

            this._loadCompanyCodes();
        },

        _setDefaultFilters: function () {
            this.byId("cbCompanyCode").setSelectedKey("1000");
            this.byId("selReportType").setSelectedKey("V");
            this.byId("miBusinessPartner").removeAllTokens();
            this.byId("miBPGroup").removeAllTokens();
            this.byId("dpEvaluationDate").setDateValue(new Date());
        },

        onClearFilters: function () {
            this._setDefaultFilters();
            this._resetResults();
        },

        onReportTypeChange: function () {
            // Vendor and customer share no partners/groups -> clear dependent selections.
            this.byId("miBusinessPartner").removeAllTokens();
            this.byId("miBPGroup").removeAllTokens();
            this._resetResults();
        },

        onTabSelect: function (oEvent) {
            this._sActiveTab = oEvent.getParameter("key") || "LINE";
        },

        _resetResults: function () {
            const oModel = this.getView().getModel("summary");
            oModel.setProperty("/lineItems", []);
            oModel.setProperty("/summaryRows", []);
            oModel.setProperty("/lineCount", 0);
            oModel.setProperty("/summaryCount", 0);
        },

        /* ============================================================== */
        /* Search                                                          */
        /* ============================================================== */

        onSearch: async function () {
            const oSummaryModel = this.getView().getModel("summary");
            const oCriteria = this._getFilterCriteria();

            if (!this._validateCriteria(oCriteria)) {
                return;
            }

            oSummaryModel.setProperty("/busy", true);
            this._resetResults();

            try {
                const aItems = await this._readItems(oCriteria);
                const aLineItems = this._buildLineItems(aItems, oCriteria);
                const aSummaryRows = this._buildSummaryRows(aLineItems);

                oSummaryModel.setProperty("/lineItems", aLineItems);
                oSummaryModel.setProperty("/summaryRows", aSummaryRows);
                oSummaryModel.setProperty("/lineCount", aLineItems.length);
                oSummaryModel.setProperty("/summaryCount", aSummaryRows.filter(function (oRow) {
                    return !oRow.IsTotal;
                }).length);

                MessageToast.show(aLineItems.length
                    ? aLineItems.length + " open item(s) loaded."
                    : "No open items found for the selected criteria.");
            } catch (oError) {
                MessageBox.error(this._getErrorText(oError));
            } finally {
                oSummaryModel.setProperty("/busy", false);
            }
        },

        _getFilterCriteria: function () {
            const sReportType = this.byId("selReportType").getSelectedKey() || "V";
            const oCombo = this.byId("cbCompanyCode");

            return {
                CompanyCode: (oCombo.getSelectedKey() || oCombo.getValue() || "").trim(),
                ReportType: sReportType,
                FinancialAccountType: this._reportTypeToFinType(sReportType),
                SelectedBusinessPartners: this._getSelectedBusinessPartners(),
                SelectedGroups: this._getSelectedGroups(),
                EvaluationDate: this.byId("dpEvaluationDate").getDateValue()
            };
        },

        _reportTypeToFinType: function (sReportType) {
            return sReportType === "C" ? "D" : "K";
        },

        _validateCriteria: function (oCriteria) {
            if (!oCriteria.CompanyCode) {
                MessageBox.warning("Company Code is required.");
                return false;
            }
            if (!oCriteria.ReportType) {
                MessageBox.warning("Report Name is required.");
                return false;
            }
            if (!oCriteria.EvaluationDate) {
                MessageBox.warning("Evaluation Date is required.");
                return false;
            }
            return true;
        },

        /* ============================================================== */
        /* OData read                                                      */
        /* ============================================================== */

        _readItems: async function (oCriteria) {
            const oModel = this.getView().getModel();
            const sKeyDate = this._toIsoDate(oCriteria.EvaluationDate);
            const aFilters = [];

            aFilters.push(new Filter("CompanyCode", FilterOperator.EQ, oCriteria.CompanyCode));
            aFilters.push(new Filter("FinancialAccountType", FilterOperator.EQ, oCriteria.FinancialAccountType));
            aFilters.push(new Filter("PostingDate", FilterOperator.LE, sKeyDate));

            // Open as of key date: not cleared, OR cleared only after the key date.
            aFilters.push(new Filter({
                and: false,
                filters: [
                    new Filter("ClearingJournalEntry", FilterOperator.EQ, ""),
                    new Filter("ClearingDate", FilterOperator.GT, sKeyDate)
                ]
            }));

            const oBinding = oModel.bindList(
                ENTITY_SET,
                undefined,
                [],
                aFilters,
                {
                    "$select": [
                        "CompanyCode", "FiscalYear", "AccountingDocument", "AccountingDocumentItem",
                        "FinancialAccountType", "ReportName", "AccountNumber", "AccountName", "AccountGroup",
                        "ReferenceDocument", "ReferenceDocumentDate", "ReconciliationAccount", "ReconciliationAccountName",
                        "PostingDate", "DocumentDate", "DueDate", "AssignmentReference", "DocumentNumber",
                        "DocumentType", "DocumentTypeName", "Amount", "CompanyCodeCurrency",
                        "ClearingJournalEntry", "ClearingDate"
                    ].join(",")
                }
            );

            return await this._requestAllContexts(oBinding, 1000, 100000);
        },

        _requestAllContexts: async function (oBinding, iPageSize, iMaxRows) {
            const aResult = [];
            let iStart = 0;

            while (true) {
                const aContexts = await oBinding.requestContexts(iStart, iPageSize);
                if (!aContexts.length) {
                    break;
                }
                aContexts.forEach(function (oContext) {
                    aResult.push(oContext.getObject());
                });
                if (aContexts.length < iPageSize) {
                    break;
                }
                iStart += iPageSize;
                if (aResult.length >= iMaxRows) {
                    throw new Error("Too many records found. Please narrow the selection (Company Code, Vendor/Customer, or Group).");
                }
            }
            return aResult;
        },

        /* ============================================================== */
        /* Aging + bucket logic (client-side, authoritative 7-bucket spec) */
        /* ============================================================== */

        // Whole days between a date and the key date: (keyDate - date).
        // Positive = date is in the past; negative = date is in the future; 0 for an invalid date.
        _computeAge: function (sDate, sKeyDate) {
            const sVal = this._normalizeDate(sDate);
            if (!sVal || sVal === "0000-00-00") {
                return 0;
            }
            const iVal = this._toEpochDay(sVal);
            const iKey = this._toEpochDay(sKeyDate);
            if (iVal === null || iKey === null) {
                return 0;
            }
            return iKey - iVal;
        },

        _toEpochDay: function (sIsoDate) {
            if (!sIsoDate) {
                return null;
            }
            const aParts = sIsoDate.substring(0, 10).split("-");
            if (aParts.length !== 3) {
                return null;
            }
            return Math.floor(Date.UTC(Number(aParts[0]), Number(aParts[1]) - 1, Number(aParts[2])) / 86400000);
        },

        // Aging buckets are based on DOCUMENT age (EvaluationDate - DocumentDate).
        // Caller guarantees iDocAge >= 0. First band is 0-30 (includes same-day documents).
        _docBucketOf: function (iDocAge, fAmount) {
            const oBucket = { D0_30: 0, D31_60: 0, D61_90: 0, D91_120: 0, D121_150: 0, D150p: 0 };
            if (iDocAge <= 30) {
                oBucket.D0_30 = fAmount;
            } else if (iDocAge <= 60) {
                oBucket.D31_60 = fAmount;
            } else if (iDocAge <= 90) {
                oBucket.D61_90 = fAmount;
            } else if (iDocAge <= 120) {
                oBucket.D91_120 = fAmount;
            } else if (iDocAge <= 150) {
                oBucket.D121_150 = fAmount;
            } else {
                oBucket.D150p = fAmount;
            }
            return oBucket;
        },

        _isOpenAsOfKeyDate: function (oItem, sKeyDate) {
            const sClearingDoc = String(oItem.ClearingJournalEntry || "").trim();
            if (!sClearingDoc) {
                return true;
            }
            const sClearingDate = this._normalizeDate(oItem.ClearingDate);
            if (!sClearingDate || sClearingDate === "0000-00-00") {
                return true;
            }
            return sClearingDate > sKeyDate;
        },

        // _buildLineItems: function (aItems, oCriteria) {
        //     const sKeyDate = this._toIsoDate(oCriteria.EvaluationDate);
        //     const sKeyDateDisp = this.formatDate(sKeyDate);
        //     const aRows = [];

        //     const oSelBPs = {};
        //     (oCriteria.SelectedBusinessPartners || []).forEach(function (sBP) {
        //         oSelBPs[this._normalizeBusinessPartner(sBP)] = true;
        //     }.bind(this));
        //     const bFilterBP = Object.keys(oSelBPs).length > 0;

        //     const oSelGroups = {};
        //     (oCriteria.SelectedGroups || []).forEach(function (sG) {
        //         oSelGroups[String(sG).trim()] = true;
        //     });
        //     const bFilterGroup = Object.keys(oSelGroups).length > 0;

        //     (aItems || []).forEach(function (oItem) {
        //         if (!this._isOpenAsOfKeyDate(oItem, sKeyDate)) {
        //             return;
        //         }
        //         if (bFilterBP && !oSelBPs[this._normalizeBusinessPartner(oItem.AccountNumber)]) {
        //             return;
        //         }
        //         if (bFilterGroup && !oSelGroups[String(oItem.AccountGroup || "").trim()]) {
        //             return;
        //         }

        //         // Aging is based on document age. Drop items whose Document Date is after the
        //         // Evaluation Date (negative document age).
        //         const iDocAge = this._computeAge(oItem.DocumentDate, sKeyDate);
        //         if (iDocAge < 0) {
        //             return;
        //         }

        //         // Normalize to positive outstanding balance (AP 'K' is stored as credits -> flip).
        //         const fRaw = this._toNumber(oItem.Amount);
        //         const fAmount = oCriteria.FinancialAccountType === "K" ? -fRaw : fRaw;

        //         // Buckets by document age. "Not Due" is a SEPARATE overlay by due date (strictly
        //         // future: Eval - Due < 0), so an item due exactly today is NOT counted as Not Due.
        //         const oBucket = this._docBucketOf(iDocAge, fAmount);
        //         const iDueAge = this._computeAge(oItem.DueDate, sKeyDate);
        //         const fNotDue = iDueAge < 0 ? fAmount : 0;

        //         aRows.push({
        //             ReportName: oItem.ReportName || "",
        //             EvaluationDate: sKeyDate,
        //             EvaluationDateDisp: sKeyDateDisp,
        //             AccountNumber: String(oItem.AccountNumber || "").trim(),
        //             AccountName: oItem.AccountName || "",
        //             AccountGroup: oItem.AccountGroup || "",
        //             ReferenceDocument: String(oItem.ReferenceDocument || "").trim(),
        //             ReferenceDocumentDate: oItem.ReferenceDocumentDate || "",
        //             ReferenceDocumentDateDisp: this.formatDate(oItem.ReferenceDocumentDate),
        //             ReconciliationAccount: oItem.ReconciliationAccount || "",
        //             ReconciliationAccountName: oItem.ReconciliationAccountName || "",
        //             PostingDate: oItem.PostingDate || "",
        //             PostingDateDisp: this.formatDate(oItem.PostingDate),
        //             DocumentDate: oItem.DocumentDate || "",
        //             DocumentDateDisp: this.formatDate(oItem.DocumentDate),
        //             DueDate: oItem.DueDate || "",
        //             DueDateDisp: this.formatDate(oItem.DueDate),
        //             AssignmentReference: String(oItem.AssignmentReference || "").trim(),
        //             DocumentNumber: String(oItem.DocumentNumber || "").trim(),
        //             DocumentType: oItem.DocumentType || "",
        //             DocumentTypeName: oItem.DocumentTypeName || "",
        //             Currency: String(oItem.CompanyCodeCurrency || "").trim(),
        //             DocAge: iDocAge,
        //             Amount: fAmount,
        //             NotDue: fNotDue,
        //             D0_30: oBucket.D0_30,
        //             D31_60: oBucket.D31_60,
        //             D61_90: oBucket.D61_90,
        //             D91_120: oBucket.D91_120,
        //             D121_150: oBucket.D121_150,
        //             D150p: oBucket.D150p,
        //             IsTotal: false
        //         });
        //     }.bind(this));

        //     aRows.sort(function (a, b) {
        //         return String(a.AccountNumber).localeCompare(String(b.AccountNumber)) ||
        //             String(a.DocumentNumber).localeCompare(String(b.DocumentNumber));
        //     });

        //     return aRows;
        // },

        _buildLineItems: function (aItems, oCriteria) {
            const sKeyDate = this._toIsoDate(oCriteria.EvaluationDate);
            const sKeyDateDisp = this.formatDate(sKeyDate);
            const aRows = [];

            const oSelBPs = {};
            (oCriteria.SelectedBusinessPartners || []).forEach(function (sBP) {
                oSelBPs[this._normalizeBusinessPartner(sBP)] = true;
            }.bind(this));
            const bFilterBP = Object.keys(oSelBPs).length > 0;

            const oSelGroups = {};
            (oCriteria.SelectedGroups || []).forEach(function (sG) {
                oSelGroups[String(sG).trim()] = true;
            });
            const bFilterGroup = Object.keys(oSelGroups).length > 0;

            (aItems || []).forEach(function (oItem) {
                if (!this._isOpenAsOfKeyDate(oItem, sKeyDate)) {
                    return;
                }
                if (bFilterBP && !oSelBPs[this._normalizeBusinessPartner(oItem.AccountNumber)]) {
                    return;
                }
                if (bFilterGroup && !oSelGroups[String(oItem.AccountGroup || "").trim()]) {
                    return;
                }

                // Aging is based on document age. Drop items whose Document Date is after the
                // Evaluation Date (negative document age).
                const iDocAge = this._computeAge(oItem.DocumentDate, sKeyDate);
                if (iDocAge < 0) {
                    return;
                }

                // Normalize to positive outstanding balance (AP 'K' is stored as credits -> flip).
                const fRaw = this._toNumber(oItem.Amount);
                const fAmount = oCriteria.FinancialAccountType === "K" ? -fRaw : fRaw;

                // Buckets by document age.
                const oBucket = this._docBucketOf(iDocAge, fAmount);

                aRows.push({
                    ReportName: oItem.ReportName || "",
                    EvaluationDate: sKeyDate,
                    EvaluationDateDisp: sKeyDateDisp,
                    AccountNumber: String(oItem.AccountNumber || "").trim(),
                    AccountName: oItem.AccountName || "",
                    AccountGroup: oItem.AccountGroup || "",
                    ReferenceDocument: String(oItem.ReferenceDocument || "").trim(),
                    ReferenceDocumentDate: oItem.ReferenceDocumentDate || "",
                    ReferenceDocumentDateDisp: this.formatDate(oItem.ReferenceDocumentDate),
                    ReconciliationAccount: oItem.ReconciliationAccount || "",
                    ReconciliationAccountName: oItem.ReconciliationAccountName || "",
                    PostingDate: oItem.PostingDate || "",
                    PostingDateDisp: this.formatDate(oItem.PostingDate),
                    DocumentDate: oItem.DocumentDate || "",
                    DocumentDateDisp: this.formatDate(oItem.DocumentDate),
                    DueDate: oItem.DueDate || "",
                    DueDateDisp: this.formatDate(oItem.DueDate),
                    AssignmentReference: String(oItem.AssignmentReference || "").trim(),
                    DocumentNumber: String(oItem.DocumentNumber || "").trim(),
                    DocumentType: oItem.DocumentType || "",
                    DocumentTypeName: oItem.DocumentTypeName || "",
                    Currency: String(oItem.CompanyCodeCurrency || "").trim(),
                    DocAge: iDocAge,
                    Amount: fAmount,
                    D0_30: oBucket.D0_30,
                    D31_60: oBucket.D31_60,
                    D61_90: oBucket.D61_90,
                    D91_120: oBucket.D91_120,
                    D121_150: oBucket.D121_150,
                    D150p: oBucket.D150p,
                    IsTotal: false
                });
            }.bind(this));

            aRows.sort(function (a, b) {
                return String(a.AccountNumber).localeCompare(String(b.AccountNumber)) ||
                    String(a.DocumentNumber).localeCompare(String(b.DocumentNumber));
            });

            return aRows;
        },

        // _buildSummaryRows: function (aLineItems) {
        //     const mSummary = {};
        //     const aBucketKeys = ["Amount", "NotDue", "D0_30", "D31_60", "D61_90", "D91_120", "D121_150", "D150p"];

        //     (aLineItems || []).forEach(function (oLine) {
        //         const sKey = [oLine.AccountNumber, oLine.Currency].join("|");
        //         if (!mSummary[sKey]) {
        //             mSummary[sKey] = {
        //                 ReportName: oLine.ReportName,
        //                 EvaluationDate: oLine.EvaluationDate,
        //                 EvaluationDateDisp: oLine.EvaluationDateDisp,
        //                 AccountNumber: oLine.AccountNumber,
        //                 AccountName: oLine.AccountName,
        //                 AccountGroup: oLine.AccountGroup,
        //                 ReconciliationAccount: oLine.ReconciliationAccount,
        //                 ReconciliationAccountName: oLine.ReconciliationAccountName,
        //                 Currency: oLine.Currency,
        //                 Amount: 0, NotDue: 0, D0_30: 0, D31_60: 0, D61_90: 0, D91_120: 0, D121_150: 0, D150p: 0,
        //                 IsTotal: false
        //             };
        //         }
        //         aBucketKeys.forEach(function (sField) {
        //             mSummary[sKey][sField] += this._toNumber(oLine[sField]);
        //         }.bind(this));
        //     }.bind(this));

        //     const aRows = Object.keys(mSummary).map(function (sKey) {
        //         return mSummary[sKey];
        //     });

        //     aRows.sort(function (a, b) {
        //         return String(a.AccountNumber).localeCompare(String(b.AccountNumber)) ||
        //             String(a.Currency).localeCompare(String(b.Currency));
        //     });

        //     if (!aRows.length) {
        //         return aRows;
        //     }

        //     // Grand Total row(s) as the last row(s), one per currency.
        //     const mTotals = {};
        //     aRows.forEach(function (oRow) {
        //         const sCur = oRow.Currency || "";
        //         if (!mTotals[sCur]) {
        //             mTotals[sCur] = {
        //                 ReportName: "",
        //                 EvaluationDate: oRow.EvaluationDate,
        //                 EvaluationDateDisp: oRow.EvaluationDateDisp,
        //                 AccountNumber: "",
        //                 AccountName: "",
        //                 AccountGroup: "",
        //                 ReconciliationAccount: "",
        //                 ReconciliationAccountName: "",
        //                 Currency: sCur,
        //                 Amount: 0, NotDue: 0, D0_30: 0, D31_60: 0, D61_90: 0, D91_120: 0, D121_150: 0, D150p: 0,
        //                 IsTotal: true
        //             };
        //         }
        //         aBucketKeys.forEach(function (sField) {
        //             mTotals[sCur][sField] += this._toNumber(oRow[sField]);
        //         }.bind(this));
        //     }.bind(this));

        //     Object.keys(mTotals).sort().forEach(function (sCur) {
        //         aRows.push(mTotals[sCur]);
        //     });

        //     return aRows;
        // },

        _buildSummaryRows: function (aLineItems) {
            const mSummary = {};
            const aBucketKeys = ["Amount", "D0_30", "D31_60", "D61_90", "D91_120", "D121_150", "D150p"];

            (aLineItems || []).forEach(function (oLine) {
                const sKey = [oLine.AccountNumber, oLine.Currency].join("|");
                if (!mSummary[sKey]) {
                    mSummary[sKey] = {
                        ReportName: oLine.ReportName,
                        EvaluationDate: oLine.EvaluationDate,
                        EvaluationDateDisp: oLine.EvaluationDateDisp,
                        AccountNumber: oLine.AccountNumber,
                        AccountName: oLine.AccountName,
                        AccountGroup: oLine.AccountGroup,
                        ReconciliationAccount: oLine.ReconciliationAccount,
                        ReconciliationAccountName: oLine.ReconciliationAccountName,
                        Currency: oLine.Currency,
                        Amount: 0, D0_30: 0, D31_60: 0, D61_90: 0, D91_120: 0, D121_150: 0, D150p: 0,
                        IsTotal: false
                    };
                }
                aBucketKeys.forEach(function (sField) {
                    mSummary[sKey][sField] += this._toNumber(oLine[sField]);
                }.bind(this));
            }.bind(this));

            const aRows = Object.keys(mSummary).map(function (sKey) {
                return mSummary[sKey];
            });

            aRows.sort(function (a, b) {
                return String(a.AccountNumber).localeCompare(String(b.AccountNumber)) ||
                    String(a.Currency).localeCompare(String(b.Currency));
            });

            if (!aRows.length) {
                return aRows;
            }

            // Grand Total row(s) as the last row(s), one per currency.
            const mTotals = {};
            aRows.forEach(function (oRow) {
                const sCur = oRow.Currency || "";
                if (!mTotals[sCur]) {
                    mTotals[sCur] = {
                        ReportName: "",
                        EvaluationDate: oRow.EvaluationDate,
                        EvaluationDateDisp: oRow.EvaluationDateDisp,
                        AccountNumber: "",
                        AccountName: "",
                        AccountGroup: "",
                        ReconciliationAccount: "",
                        ReconciliationAccountName: "",
                        Currency: sCur,
                        Amount: 0, D0_30: 0, D31_60: 0, D61_90: 0, D91_120: 0, D121_150: 0, D150p: 0,
                        IsTotal: true
                    };
                }
                aBucketKeys.forEach(function (sField) {
                    mTotals[sCur][sField] += this._toNumber(oRow[sField]);
                }.bind(this));
            }.bind(this));

            Object.keys(mTotals).sort().forEach(function (sCur) {
                aRows.push(mTotals[sCur]);
            });

            return aRows;
        },

        /* ============================================================== */
        /* Company Code dropdown (from released value-help entity)         */
        /* ============================================================== */

        _loadCompanyCodes: async function () {
            const oCcModel = this.getView().getModel("ccList");
            try {
                const oModel = this.getView().getModel();
                const oBinding = oModel.bindList(CC_VH_SET, undefined, [], [], {
                    "$select": "CompanyCode,CompanyCodeName"
                });
                const aContexts = await oBinding.requestContexts(0, 1000);

                const aItems = aContexts.map(function (oContext) {
                    const o = oContext.getObject();
                    const sCC = String(o.CompanyCode || "").trim();
                    const sName = String(o.CompanyCodeName || "").trim();
                    return { key: sCC, text: sName ? (sCC + " - " + sName) : sCC };
                }).filter(function (oItem) {
                    return oItem.key;
                });

                aItems.sort(function (a, b) {
                    return a.key.localeCompare(b.key);
                });
                oCcModel.setProperty("/items", aItems);
            } catch (oError) {
                // Fallback keeps the default typed value usable if the VH entity is unavailable.
                oCcModel.setProperty("/items", [{ key: "1000", text: "1000" }]);
            }
        },

        /* ============================================================== */
        /* Formatters / helpers                                            */
        /* ============================================================== */

        _normalizeDate: function (vDate) {
            if (!vDate) {
                return "";
            }
            if (typeof vDate === "string") {
                return vDate.substring(0, 10);
            }
            return this._toIsoDate(vDate);
        },

        _toIsoDate: function (oDate) {
            if (!oDate) {
                return "";
            }
            if (typeof oDate === "string") {
                return oDate.substring(0, 10);
            }
            const iYear = oDate.getFullYear();
            const iMonth = String(oDate.getMonth() + 1).padStart(2, "0");
            const iDay = String(oDate.getDate()).padStart(2, "0");
            return `${iYear}-${iMonth}-${iDay}`;
        },

        formatDate: function (vDate) {
            if (!vDate) {
                return "";
            }
            const sDate = typeof vDate === "string" ? vDate.substring(0, 10) : this._toIsoDate(vDate);
            const aParts = sDate.split("-");
            if (aParts.length !== 3 || aParts[0] === "0000") {
                return "";
            }
            return `${aParts[2]}.${aParts[1]}.${aParts[0]}`;
        },

        _toNumber: function (vValue) {
            if (vValue === null || vValue === undefined || vValue === "") {
                return 0;
            }
            return Number(vValue) || 0;
        },

        formatAmount: function (vAmount) {
            const fAmount = this._toNumber(vAmount);
            if (!fAmount) {
                return "";
            }
            return fAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        },

        /* ============================================================== */
        /* Export (dates exported as preformatted strings)                 */
        /* ============================================================== */

        onExport: function () {
            const oModel = this.getView().getModel("summary");
            const bSummary = this._sActiveTab === "SUMMARY";
            const aRows = bSummary ? (oModel.getProperty("/summaryRows") || []) : (oModel.getProperty("/lineItems") || []);

            if (!aRows.length) {
                MessageToast.show("No data available to export.");
                return;
            }

            // Report Name + Evaluation Date are constant per run -> instead of repeating them in
            // every row, expose them once. sap.ui.export cannot place a caption above the data table,
            // so they are written to a dedicated "Report Info" metadata sheet in the workbook.
            const oHeader = aRows.filter(function (oRow) { return !oRow.IsTotal; })[0] || aRows[0];
            const sReportName = oHeader.ReportName || "";
            const sEvalDisp = oHeader.EvaluationDateDisp || "";

            const oSpreadsheet = new Spreadsheet({
                workbook: {
                    columns: bSummary ? this._getSummaryExportColumns() : this._getLineItemExportColumns(),
                    context: {
                        sheetName: bSummary ? "Summary" : "Line Items",
                        title: sReportName ? sReportName + " (Evaluation Date " + sEvalDisp + ")" : "Vendor/Customer Aging",
                        metaSheetName: "Report Info",
                        metainfo: [{
                            name: "Vendor/Customer Aging",
                            items: [
                                { key: "Report Name", value: sReportName },
                                { key: "Evaluation Date", value: sEvalDisp }
                            ]
                        }]
                    }
                },
                dataSource: aRows,
                fileName: bSummary ? "VC_Aging_Summary.xlsx" : "VC_Aging_LineItems.xlsx"
            });

            oSpreadsheet.build().finally(function () {
                oSpreadsheet.destroy();
            });
        },

        // _getBucketExportColumns: function () {
        //     // delimiter:true -> Excel shows grouping separators (e.g. 12,345,678.00) while the
        //     // cell value stays a real number (still summable/sortable).
        //     return [
        //         { label: "Currency", property: "Currency", type: EdmType.String },
        //         { label: "Total Amount", property: "Amount", type: EdmType.Number, scale: 2, delimiter: true },
        //         { label: "Not Due", property: "NotDue", type: EdmType.Number, scale: 2, delimiter: true },
        //         { label: "0 - 30", property: "D0_30", type: EdmType.Number, scale: 2, delimiter: true },
        //         { label: "31 - 60", property: "D31_60", type: EdmType.Number, scale: 2, delimiter: true },
        //         { label: "61 - 90", property: "D61_90", type: EdmType.Number, scale: 2, delimiter: true },
        //         { label: "91 - 120", property: "D91_120", type: EdmType.Number, scale: 2, delimiter: true },
        //         { label: "121 - 150", property: "D121_150", type: EdmType.Number, scale: 2, delimiter: true },
        //         { label: "150 +", property: "D150p", type: EdmType.Number, scale: 2, delimiter: true }
        //     ];
        // },

        _getBucketExportColumns: function () {
            // delimiter:true -> Excel shows grouping separators (e.g. 12,345,678.00) while the
            // cell value stays a real number (still summable/sortable).
            return [
                { label: "Currency", property: "Currency", type: EdmType.String },
                { label: "Total Amount", property: "Amount", type: EdmType.Number, scale: 2, delimiter: true },
                { label: "0 - 30", property: "D0_30", type: EdmType.Number, scale: 2, delimiter: true },
                { label: "31 - 60", property: "D31_60", type: EdmType.Number, scale: 2, delimiter: true },
                { label: "61 - 90", property: "D61_90", type: EdmType.Number, scale: 2, delimiter: true },
                { label: "91 - 120", property: "D91_120", type: EdmType.Number, scale: 2, delimiter: true },
                { label: "121 - 150", property: "D121_150", type: EdmType.Number, scale: 2, delimiter: true },
                { label: "150 +", property: "D150p", type: EdmType.Number, scale: 2, delimiter: true }
            ];
        },

        _getSummaryExportColumns: function () {
            // Report Name & Evaluation Date are omitted here (shown as the sheet title caption).
            return [
                { label: "Vendor/Customer Number", property: "AccountNumber", type: EdmType.String },
                { label: "Name", property: "AccountName", type: EdmType.String },
                { label: "Group", property: "AccountGroup", type: EdmType.String },
                { label: "Reconciliation Account", property: "ReconciliationAccount", type: EdmType.String },
                { label: "Reconciliation Account Description", property: "ReconciliationAccountName", type: EdmType.String }
            ].concat(this._getBucketExportColumns());
        },

        _getLineItemExportColumns: function () {
            // Report Name & Evaluation Date are omitted here (shown as the sheet title caption).
            return [
                { label: "Vendor/Customer Number", property: "AccountNumber", type: EdmType.String },
                { label: "Name", property: "AccountName", type: EdmType.String },
                { label: "Group", property: "AccountGroup", type: EdmType.String },
                { label: "PO/Invoice Number", property: "ReferenceDocument", type: EdmType.String },
                { label: "PO/Invoice Date", property: "ReferenceDocumentDateDisp", type: EdmType.String },
                { label: "Reconciliation Account", property: "ReconciliationAccount", type: EdmType.String },
                { label: "Reconciliation Account Description", property: "ReconciliationAccountName", type: EdmType.String },
                { label: "Posting Date", property: "PostingDateDisp", type: EdmType.String },
                { label: "Document Date", property: "DocumentDateDisp", type: EdmType.String },
                { label: "Due Date", property: "DueDateDisp", type: EdmType.String },
                { label: "Invoice/Assignment Number", property: "AssignmentReference", type: EdmType.String },
                { label: "Document Number", property: "DocumentNumber", type: EdmType.String },
                { label: "Document Type", property: "DocumentType", type: EdmType.String },
                { label: "Document Description", property: "DocumentTypeName", type: EdmType.String }
            ].concat(this._getBucketExportColumns());
        },

        /* ============================================================== */
        /* Vendor/Customer multi-select value help                         */
        /* ============================================================== */

        _normalizeBusinessPartner: function (sValue) {
            return String(sValue || "").trim().replace(/^0+/, "");
        },

        _compareBusinessPartner: function (sValue1, sValue2) {
            const s1 = this._normalizeBusinessPartner(sValue1);
            const s2 = this._normalizeBusinessPartner(sValue2);
            const n1 = Number(s1);
            const n2 = Number(s2);
            if (!isNaN(n1) && !isNaN(n2)) {
                return n1 - n2;
            }
            return s1.localeCompare(s2);
        },

        _getSelectedBusinessPartners: function () {
            const oMultiInput = this.byId("miBusinessPartner");
            if (!oMultiInput) {
                return [];
            }
            return oMultiInput.getTokens().map(function (oToken) {
                return String(oToken.getKey() || oToken.getText() || "").trim();
            }).filter(Boolean);
        },

        _loadBusinessPartnerVH: async function (sSearchValue) {
            const oModel = this.getView().getModel();
            const aFilters = this._baseVHFilters();

            if (sSearchValue) {
                const sSearch = String(sSearchValue).trim().replace(/^0+/, "");
                aFilters.push(new Filter({
                    and: false,
                    filters: [
                        new Filter("AccountNumber", FilterOperator.Contains, sSearch),
                        new Filter("AccountName", FilterOperator.Contains, sSearchValue)
                    ]
                }));
            }

            const oBinding = oModel.bindList(ENTITY_SET, undefined, [], aFilters, {
                "$select": ["AccountNumber", "AccountName", "AccountGroup", "FinancialAccountType"].join(",")
            });

            const aContexts = await oBinding.requestContexts(0, 500);
            const mUnique = {};
            const aItems = [];
            aContexts.forEach(function (oContext) {
                const oObject = oContext.getObject();
                const sBP = String(oObject.AccountNumber || "").trim();
                if (!sBP || mUnique[sBP]) {
                    return;
                }
                mUnique[sBP] = true;
                aItems.push({ BusinessPartner: sBP, BusinessPartnerName: String(oObject.AccountName || "").trim() });
            });
            aItems.sort(function (a, b) {
                return this._compareBusinessPartner(a.BusinessPartner, b.BusinessPartner);
            }.bind(this));
            return aItems;
        },

        // Common Company Code + Report Type (+ selected Group) scope for value helps.
        _baseVHFilters: function () {
            const oCombo = this.byId("cbCompanyCode");
            const sCompanyCode = (oCombo.getSelectedKey() || oCombo.getValue() || "").trim();
            const sFinType = this._reportTypeToFinType(this.byId("selReportType").getSelectedKey() || "V");
            const aGroups = this._getSelectedGroups();
            const aFilters = [];

            if (sCompanyCode) {
                aFilters.push(new Filter("CompanyCode", FilterOperator.EQ, sCompanyCode));
            }
            aFilters.push(new Filter("FinancialAccountType", FilterOperator.EQ, sFinType));

            if (aGroups.length) {
                aFilters.push(new Filter({
                    and: false,
                    filters: aGroups.map(function (sG) {
                        return new Filter("AccountGroup", FilterOperator.EQ, sG);
                    })
                }));
            }
            return aFilters;
        },

        onBusinessPartnerMultiValueHelp: async function () {
            if (!this.getView().getModel("bpMultiVH")) {
                this.getView().setModel(new JSONModel({ items: [] }), "bpMultiVH");
            }

            this._mBPSelectionTemp = {};
            this._getSelectedBusinessPartners().forEach(function (sBP) {
                this._mBPSelectionTemp[this._normalizeBusinessPartner(sBP)] = { BusinessPartner: sBP, BusinessPartnerName: "" };
            }.bind(this));

            if (!this._oBPMultiValueHelpDialog) {
                this._oBPMultiValueHelpDialog = new SelectDialog({
                    title: "Vendor/Customer Number",
                    multiSelect: true,
                    rememberSelections: true,
                    search: this.onBusinessPartnerMultiVHSearch.bind(this),
                    liveChange: this.onBusinessPartnerMultiVHSearch.bind(this),
                    selectionChange: this.onBusinessPartnerMultiVHSelectionChange.bind(this),
                    confirm: function () {
                        this._applyBusinessPartnerMultiTokens();
                    }.bind(this)
                });

                this._oBPMultiValueHelpDialog.bindAggregation("items", {
                    path: "bpMultiVH>/items",
                    template: new StandardListItem({
                        title: "{bpMultiVH>BusinessPartner}",
                        description: "{bpMultiVH>BusinessPartnerName}",
                        selected: "{bpMultiVH>Selected}",
                        type: "Active"
                    })
                });

                this.getView().addDependent(this._oBPMultiValueHelpDialog);
            }

            this.getView().getModel("bpMultiVH").setProperty("/items", []);
            this._oBPMultiValueHelpDialog.setBusy(true);
            this._oBPMultiValueHelpDialog.open();

            try {
                const aItems = await this._loadBusinessPartnerMultiVH("");
                this.getView().getModel("bpMultiVH").setProperty("/items", aItems);
            } catch (oError) {
                MessageBox.error(this._getErrorText(oError));
            } finally {
                this._oBPMultiValueHelpDialog.setBusy(false);
            }
        },

        onBusinessPartnerMultiVHSearch: function (oEvent) {
            const sValue = oEvent.getParameter("value") || "";
            clearTimeout(this._iBPMultiVHSearchTimer);
            this._iBPMultiVHSearchTimer = setTimeout(async function () {
                if (!this._oBPMultiValueHelpDialog) {
                    return;
                }
                this._oBPMultiValueHelpDialog.setBusy(true);
                try {
                    const aItems = await this._loadBusinessPartnerMultiVH(sValue);
                    this.getView().getModel("bpMultiVH").setProperty("/items", aItems);
                } catch (oError) {
                    MessageBox.error(this._getErrorText(oError));
                } finally {
                    this._oBPMultiValueHelpDialog.setBusy(false);
                }
            }.bind(this), 300);
        },

        onBusinessPartnerMultiVHSelectionChange: function (oEvent) {
            const oItem = oEvent.getParameter("selectedItem") || oEvent.getParameter("listItem");
            if (!oItem) {
                return;
            }
            const oContext = oItem.getBindingContext("bpMultiVH");
            if (!oContext) {
                return;
            }
            const oData = oContext.getObject();
            const sBP = String(oData.BusinessPartner || "").trim();
            const sKey = this._normalizeBusinessPartner(sBP);
            if (!sKey) {
                return;
            }
            const bSelected = typeof oEvent.getParameter("selected") === "boolean"
                ? oEvent.getParameter("selected")
                : oItem.getSelected();

            if (bSelected) {
                this._mBPSelectionTemp[sKey] = { BusinessPartner: sBP, BusinessPartnerName: String(oData.BusinessPartnerName || "").trim() };
            } else {
                delete this._mBPSelectionTemp[sKey];
            }
        },

        _loadBusinessPartnerMultiVH: async function (sSearchValue) {
            const aItems = await this._loadBusinessPartnerVH(sSearchValue);
            const mSelected = this._mBPSelectionTemp || {};
            return aItems.map(function (oItem) {
                const sKey = this._normalizeBusinessPartner(oItem.BusinessPartner);
                return {
                    BusinessPartner: oItem.BusinessPartner,
                    BusinessPartnerName: oItem.BusinessPartnerName,
                    Selected: !!mSelected[sKey]
                };
            }.bind(this));
        },

        _applyBusinessPartnerMultiTokens: function () {
            const oMultiInput = this.byId("miBusinessPartner");
            if (!oMultiInput) {
                return;
            }
            oMultiInput.removeAllTokens();

            const aKeys = Object.keys(this._mBPSelectionTemp || {});
            aKeys.sort(function (a, b) {
                return this._compareBusinessPartner(a, b);
            }.bind(this));

            aKeys.forEach(function (sKey) {
                const oBP = this._mBPSelectionTemp[sKey];
                oMultiInput.addToken(new Token({ key: oBP.BusinessPartner, text: oBP.BusinessPartner }));
            }.bind(this));
        },

        /* ============================================================== */
        /* Vendor/Customer Group multi-select value help                   */
        /* ============================================================== */

        _getSelectedGroups: function () {
            const oMultiInput = this.byId("miBPGroup");
            if (!oMultiInput) {
                return [];
            }
            return oMultiInput.getTokens().map(function (oToken) {
                return String(oToken.getKey() || oToken.getText() || "").trim();
            }).filter(Boolean);
        },

        _loadGroupVH: async function (sSearchValue) {
            const oModel = this.getView().getModel();
            const oCombo = this.byId("cbCompanyCode");
            const sCompanyCode = (oCombo.getSelectedKey() || oCombo.getValue() || "").trim();
            const sFinType = this._reportTypeToFinType(this.byId("selReportType").getSelectedKey() || "V");
            const aFilters = [new Filter("FinancialAccountType", FilterOperator.EQ, sFinType)];

            if (sCompanyCode) {
                aFilters.push(new Filter("CompanyCode", FilterOperator.EQ, sCompanyCode));
            }
            if (sSearchValue) {
                aFilters.push(new Filter("AccountGroup", FilterOperator.Contains, String(sSearchValue).trim()));
            }

            const oBinding = oModel.bindList(ENTITY_SET, undefined, [], aFilters, {
                "$select": ["AccountGroup", "FinancialAccountType", "CompanyCode"].join(",")
            });

            const aContexts = await oBinding.requestContexts(0, 500);
            const mUnique = {};
            const aItems = [];
            aContexts.forEach(function (oContext) {
                const sG = String(oContext.getObject().AccountGroup || "").trim();
                if (!sG || mUnique[sG]) {
                    return;
                }
                mUnique[sG] = true;
                aItems.push({ Group: sG });
            });
            aItems.sort(function (a, b) {
                return String(a.Group).localeCompare(String(b.Group));
            });
            return aItems;
        },

        onGroupMultiValueHelp: async function () {
            if (!this.getView().getModel("groupMultiVH")) {
                this.getView().setModel(new JSONModel({ items: [] }), "groupMultiVH");
            }

            this._mGroupSelectionTemp = {};
            this._getSelectedGroups().forEach(function (sG) {
                this._mGroupSelectionTemp[sG] = true;
            }.bind(this));

            if (!this._oGroupMultiValueHelpDialog) {
                this._oGroupMultiValueHelpDialog = new SelectDialog({
                    title: "Vendor/Customer Group",
                    multiSelect: true,
                    rememberSelections: true,
                    search: this.onGroupMultiVHSearch.bind(this),
                    liveChange: this.onGroupMultiVHSearch.bind(this),
                    selectionChange: this.onGroupMultiVHSelectionChange.bind(this),
                    confirm: function () {
                        this._applyGroupMultiTokens();
                    }.bind(this)
                });

                this._oGroupMultiValueHelpDialog.bindAggregation("items", {
                    path: "groupMultiVH>/items",
                    template: new StandardListItem({
                        title: "{groupMultiVH>Group}",
                        selected: "{groupMultiVH>Selected}",
                        type: "Active"
                    })
                });

                this.getView().addDependent(this._oGroupMultiValueHelpDialog);
            }

            this.getView().getModel("groupMultiVH").setProperty("/items", []);
            this._oGroupMultiValueHelpDialog.setBusy(true);
            this._oGroupMultiValueHelpDialog.open();

            try {
                const aItems = await this._loadGroupMultiVH("");
                this.getView().getModel("groupMultiVH").setProperty("/items", aItems);
            } catch (oError) {
                MessageBox.error(this._getErrorText(oError));
            } finally {
                this._oGroupMultiValueHelpDialog.setBusy(false);
            }
        },

        onGroupMultiVHSearch: function (oEvent) {
            const sValue = oEvent.getParameter("value") || "";
            clearTimeout(this._iGroupMultiVHSearchTimer);
            this._iGroupMultiVHSearchTimer = setTimeout(async function () {
                if (!this._oGroupMultiValueHelpDialog) {
                    return;
                }
                this._oGroupMultiValueHelpDialog.setBusy(true);
                try {
                    const aItems = await this._loadGroupMultiVH(sValue);
                    this.getView().getModel("groupMultiVH").setProperty("/items", aItems);
                } catch (oError) {
                    MessageBox.error(this._getErrorText(oError));
                } finally {
                    this._oGroupMultiValueHelpDialog.setBusy(false);
                }
            }.bind(this), 300);
        },

        onGroupMultiVHSelectionChange: function (oEvent) {
            const oItem = oEvent.getParameter("selectedItem") || oEvent.getParameter("listItem");
            if (!oItem) {
                return;
            }
            const oContext = oItem.getBindingContext("groupMultiVH");
            if (!oContext) {
                return;
            }
            const sG = String(oContext.getObject().Group || "").trim();
            if (!sG) {
                return;
            }
            const bSelected = typeof oEvent.getParameter("selected") === "boolean"
                ? oEvent.getParameter("selected")
                : oItem.getSelected();

            if (bSelected) {
                this._mGroupSelectionTemp[sG] = true;
            } else {
                delete this._mGroupSelectionTemp[sG];
            }
        },

        _loadGroupMultiVH: async function (sSearchValue) {
            const aItems = await this._loadGroupVH(sSearchValue);
            const mSelected = this._mGroupSelectionTemp || {};
            return aItems.map(function (oItem) {
                return { Group: oItem.Group, Selected: !!mSelected[oItem.Group] };
            });
        },

        _applyGroupMultiTokens: function () {
            const oMultiInput = this.byId("miBPGroup");
            if (!oMultiInput) {
                return;
            }
            oMultiInput.removeAllTokens();

            Object.keys(this._mGroupSelectionTemp || {}).sort().forEach(function (sG) {
                oMultiInput.addToken(new Token({ key: sG, text: sG }));
            });
        },

        /* ============================================================== */

        _getErrorText: function (oError) {
            if (!oError) {
                return "Unknown error occurred.";
            }
            if (oError.message) {
                return oError.message;
            }
            if (oError.responseText) {
                return oError.responseText;
            }
            return String(oError);
        }

    });
});