/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

/**
 * Helper class for creating RFC 2822 compliant MIME messages for Gmail API
 */
export class MimeHelper {
  /**
   * Creates a base64url-encoded MIME message for Gmail API
   */
  public static createMimeMessage({
    to,
    subject,
    body,
    from,
    cc,
    bcc,
    replyTo,
    inReplyTo,
    references,
    isHtml = false,
  }: {
    to: string;
    subject: string;
    body: string;
    from?: string;
    cc?: string;
    bcc?: string;
    replyTo?: string;
    inReplyTo?: string;
    references?: string;
    isHtml?: boolean;
  }): string {
    // Encode subject for UTF-8 support
    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;

    // Build message headers
    const messageParts: string[] = [];

    // Add From header if provided, otherwise Gmail will use the authenticated user
    if (from) {
      messageParts.push(`From: ${from}`);
    }

    messageParts.push(`To: ${to}`);

    if (cc) {
      messageParts.push(`Cc: ${cc}`);
    }

    if (bcc) {
      messageParts.push(`Bcc: ${bcc}`);
    }

    if (replyTo) {
      messageParts.push(`Reply-To: ${replyTo}`);
    }

    if (inReplyTo) {
      messageParts.push(
        `In-Reply-To: ${MimeHelper.sanitizeHeaderValue(inReplyTo)}`,
      );
    }

    if (references) {
      messageParts.push(
        `References: ${MimeHelper.sanitizeHeaderValue(references)}`,
      );
    }

    messageParts.push(`Subject: ${utf8Subject}`);

    // Add content type based on whether it's HTML or plain text
    if (isHtml) {
      messageParts.push('Content-Type: text/html; charset=utf-8');
    } else {
      messageParts.push('Content-Type: text/plain; charset=utf-8');
    }

    messageParts.push(''); // Empty line between headers and body
    messageParts.push(body);

    // Join all parts with CRLF as per RFC 2822
    const message = messageParts.join('\r\n');

    // Encode to base64url format required by Gmail API
    // ⚡ Bolt: Using native base64url is significantly faster than regex replacements
    const encodedMessage = Buffer.from(message).toString('base64url');

    return encodedMessage;
  }

  /**
   * Strips characters that would allow MIME header injection from a header
   * value: CR, LF, and all other C0 control characters, plus DEL (0x7f).
   * The explicit \r\n in the regex is redundant with \x00-\x1f but kept to
   * make the header-injection intent obvious.
   */
  private static sanitizeHeaderValue(value: string): string {
    return value.replace(/[\r\n\x00-\x1f\x7f]/g, '');
  }

  /**
   * Sanitizes a filename for safe use inside a quoted Content-Disposition
   * filename parameter: removes control characters (preventing header
   * injection) and escapes backslashes and double quotes (preventing
   * parameter injection / early quote termination).
   */
  private static sanitizeHeaderFilename(filename: string): string {
    return MimeHelper.sanitizeHeaderValue(filename)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
  }

  /**
   * Creates a MIME message with attachments
   */
  public static createMimeMessageWithAttachments({
    to,
    subject,
    body,
    from,
    cc,
    bcc,
    replyTo,
    inReplyTo,
    references,
    attachments,
    isHtml = false,
  }: {
    to: string;
    subject: string;
    body: string;
    from?: string;
    cc?: string;
    bcc?: string;
    replyTo?: string;
    inReplyTo?: string;
    references?: string;
    attachments?: Array<{
      filename: string;
      content: Buffer | string;
      contentType?: string;
    }>;
    isHtml?: boolean;
  }): string {
    // Fixed-offset slicing of a base-36 float is not a random suffix: the string
    // length depends on the value, so `Math.random().toString(36).substring(7)`
    // is EMPTY whenever the draw stringifies short (0.5 -> "0.i", 0 -> "0").
    // The boundary then degenerates to `boundary_<ms>_`, and two messages built
    // in the same millisecond share it -- a duplicated boundary makes the
    // receiving parser mis-split the parts. 32 hex chars are all valid RFC 2046
    // bcharsnospace and keep the whole boundary at 55 chars, under the 70 limit.
    const boundary = `boundary_${Date.now()}_${randomUUID().replace(/-/g, '')}`;
    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;

    const messageParts: string[] = [];

    // Headers
    if (from) {
      messageParts.push(`From: ${from}`);
    }
    messageParts.push(`To: ${to}`);
    if (cc) {
      messageParts.push(`Cc: ${cc}`);
    }
    if (bcc) {
      messageParts.push(`Bcc: ${bcc}`);
    }
    if (replyTo) {
      messageParts.push(`Reply-To: ${replyTo}`);
    }
    messageParts.push(`Subject: ${utf8Subject}`);
    messageParts.push('MIME-Version: 1.0');

    if (!attachments || attachments.length === 0) {
      // Simple message without attachments
      return this.createMimeMessage({
        to,
        subject,
        body,
        from,
        cc,
        bcc,
        replyTo,
        inReplyTo,
        references,
        isHtml,
      });
    }

    // Multipart message with attachments
    if (inReplyTo) {
      messageParts.push(
        `In-Reply-To: ${MimeHelper.sanitizeHeaderValue(inReplyTo)}`,
      );
    }
    if (references) {
      messageParts.push(
        `References: ${MimeHelper.sanitizeHeaderValue(references)}`,
      );
    }
    messageParts.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    messageParts.push('');

    // Body part
    messageParts.push(`--${boundary}`);
    if (isHtml) {
      messageParts.push('Content-Type: text/html; charset=utf-8');
    } else {
      messageParts.push('Content-Type: text/plain; charset=utf-8');
    }
    messageParts.push('');
    messageParts.push(body);

    // Attachments
    for (const attachment of attachments) {
      const safeContentType = MimeHelper.sanitizeHeaderValue(
        attachment.contentType || 'application/octet-stream',
      );
      const safeFilename = MimeHelper.sanitizeHeaderFilename(
        attachment.filename,
      );
      messageParts.push(`--${boundary}`);
      messageParts.push(`Content-Type: ${safeContentType}`);
      messageParts.push('Content-Transfer-Encoding: base64');
      messageParts.push(
        `Content-Disposition: attachment; filename="${safeFilename}"`,
      );
      messageParts.push('');

      const content =
        typeof attachment.content === 'string'
          ? attachment.content
          : attachment.content.toString('base64');

      // Add content in chunks of 76 characters as per MIME spec
      const chunks = content.match(/.{1,76}/g) || [];
      messageParts.push(...chunks);
    }

    // End boundary
    messageParts.push(`--${boundary}--`);

    const message = messageParts.join('\r\n');

    // Encode to base64url
    // ⚡ Bolt: Using native base64url is significantly faster than regex replacements
    return Buffer.from(message).toString('base64url');
  }

  /**
   * Decodes a base64url-encoded string (inverse of encoding)
   */
  public static decodeBase64Url(encoded: string): string {
    // ⚡ Bolt: Using native base64url is significantly faster than regex replacements
    return Buffer.from(encoded, 'base64url').toString('utf-8');
  }
}
