/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { google, sheets_v4 } from 'googleapis';
import { AuthManager } from '../auth/AuthManager';
import { logToFile } from '../utils/logger';
import { extractDocId } from '../utils/IdUtils';
import { gaxiosOptions } from '../utils/GaxiosConfig';

export class SheetsService {
  constructor(private authManager: AuthManager) {}

  private async getSheetsClient(): Promise<sheets_v4.Sheets> {
    const auth = await this.authManager.getAuthenticatedClient();
    const options = { ...gaxiosOptions, auth };
    return google.sheets({ version: 'v4', ...options });
  }

  public getText = async ({
    spreadsheetId,
    format = 'text',
  }: {
    spreadsheetId: string;
    format?: 'text' | 'csv' | 'json';
  }) => {
    logToFile(
      `[SheetsService] Starting getText for spreadsheet: ${spreadsheetId} with format: ${format}`,
    );
    try {
      const id = extractDocId(spreadsheetId) || spreadsheetId;

      const sheets = await this.getSheetsClient();
      // Get spreadsheet metadata
      const spreadsheet = await sheets.spreadsheets.get({
        spreadsheetId: id,
        includeGridData: false,
      });

      let content = '';
      const jsonData: Record<string, any[][]> = {};

      // Add spreadsheet title (except for JSON format)
      if (spreadsheet.data.properties?.title && format !== 'json') {
        content += `Spreadsheet Title: ${spreadsheet.data.properties.title}\n\n`;
      }

      // Get all sheet names
      const sheetNames =
        spreadsheet.data.sheets?.map((sheet) => sheet.properties?.title) || [];

      // Get data from all sheets concurrently
      const validSheetNames = sheetNames.filter((name): name is string => Boolean(name));

      const sheetResults = await Promise.all(
        validSheetNames.map(async (sheetName) => {
          try {
            const response = await sheets.spreadsheets.values.get({
              spreadsheetId: id,
              range: `'${sheetName}'`,
            });

            const values = response.data.values || [];

            if (format === 'json') {
              // Collect data for JSON structure (assigned safely across async boundaries)
              jsonData[sheetName] = values;
              return '';
            } else {
              let sheetContent = `Sheet Name: ${sheetName}\n`;

              if (values.length === 0) {
                sheetContent += '(Empty sheet)\n';
              } else {
                // Process each row
                values.forEach((row) => {
                  if (format === 'csv') {
                    // Convert to CSV format
                    const csvRow = row
                      .map((cell) => {
                        // Escape quotes and wrap in quotes if contains comma or quotes
                        const cellStr = String(cell || '');
                        if (
                          cellStr.includes(',') ||
                          cellStr.includes('"') ||
                          cellStr.includes('\n')
                        ) {
                          return `"${cellStr.replace(/"/g, '""')}"`;
                        }
                        return cellStr;
                      })
                      .join(',');
                    sheetContent += csvRow + '\n';
                  } else {
                    // Plain text format with pipe separators for readability
                    sheetContent += row.map((cell) => cell || '').join(' | ') + '\n';
                  }
                });
              }
              sheetContent += '\n';
              return sheetContent;
            }
          } catch (sheetError) {
            logToFile(
              `[SheetsService] Error reading sheet ${sheetName}: ${sheetError}`,
            );
            if (format === 'json') {
              // For JSON format, we'll skip sheets with errors
              logToFile(
                `[SheetsService] Skipping sheet ${sheetName} in JSON output due to error`,
              );
              return '';
            } else {
              return `Sheet Name: ${sheetName}\n(Error reading sheet)\n\n`;
            }
          }
        })
      );

      if (format === 'json') {
        // Generate clean JSON output from collected data
        content = JSON.stringify(jsonData, null, 2);
      } else {
        // Append all text results sequentially to preserve order
        content += sheetResults.join('');
      }

      logToFile(`[SheetsService] Finished getText for spreadsheet: ${id}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: content.trim(),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logToFile(`[SheetsService] Error during sheets.getText: ${errorMessage}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: errorMessage }),
          },
        ],
      };
    }
  };

  public getRange = async ({
    spreadsheetId,
    range,
  }: {
    spreadsheetId: string;
    range: string;
  }) => {
    logToFile(
      `[SheetsService] Starting getRange for spreadsheet: ${spreadsheetId}, range: ${range}`,
    );
    try {
      const id = extractDocId(spreadsheetId) || spreadsheetId;

      const sheets = await this.getSheetsClient();
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: id,
        range: range,
      });

      const values = response.data.values || [];

      logToFile(`[SheetsService] Finished getRange for spreadsheet: ${id}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              range: response.data.range,
              values: values,
            }),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logToFile(
        `[SheetsService] Error during sheets.getRange: ${errorMessage}`,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: errorMessage }),
          },
        ],
      };
    }
  };

  public getMetadata = async ({ spreadsheetId }: { spreadsheetId: string }) => {
    logToFile(
      `[SheetsService] Starting getMetadata for spreadsheet: ${spreadsheetId}`,
    );
    try {
      const id = extractDocId(spreadsheetId) || spreadsheetId;

      const sheets = await this.getSheetsClient();
      const spreadsheet = await sheets.spreadsheets.get({
        spreadsheetId: id,
        includeGridData: false,
      });

      const metadata = {
        spreadsheetId: spreadsheet.data.spreadsheetId,
        title: spreadsheet.data.properties?.title,
        sheets: spreadsheet.data.sheets?.map((sheet) => ({
          sheetId: sheet.properties?.sheetId,
          title: sheet.properties?.title,
          index: sheet.properties?.index,
          rowCount: sheet.properties?.gridProperties?.rowCount,
          columnCount: sheet.properties?.gridProperties?.columnCount,
        })),
        locale: spreadsheet.data.properties?.locale,
        timeZone: spreadsheet.data.properties?.timeZone,
      };

      logToFile(`[SheetsService] Finished getMetadata for spreadsheet: ${id}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(metadata),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logToFile(
        `[SheetsService] Error during sheets.getMetadata: ${errorMessage}`,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: errorMessage }),
          },
        ],
      };
    }
  };
}
