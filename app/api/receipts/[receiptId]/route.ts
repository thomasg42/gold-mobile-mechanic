import { apiError, getBindings, getDatabase } from "../../../../db/store";

type RouteContext = { params: Promise<{ receiptId: string }> };

export async function GET(_: Request, context: RouteContext) {
  try {
    const { receiptId } = await context.params;
    const db = await getDatabase();
    const receipt = await db
      .prepare(
        "SELECT object_key, filename, mime_type FROM receipts WHERE id = ? LIMIT 1",
      )
      .bind(receiptId)
      .first<{
        object_key: string;
        filename: string;
        mime_type: string;
      }>();
    if (!receipt) {
      return new Response("Receipt not found.", { status: 404 });
    }

    const object = await getBindings().RECEIPTS.get(receipt.object_key);
    if (!object) {
      return new Response("Receipt image not found.", { status: 404 });
    }

    return new Response(object.body, {
      headers: {
        "content-type": receipt.mime_type,
        "content-disposition": `inline; filename="${receipt.filename.replaceAll('"', "")}"`,
        "cache-control": "private, max-age=300",
        etag: object.httpEtag,
      },
    });
  } catch (error) {
    return apiError(error, "Could not load the receipt.");
  }
}
