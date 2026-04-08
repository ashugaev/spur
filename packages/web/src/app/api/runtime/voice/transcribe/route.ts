import { NextResponse } from "next/server";
import { transcribeAudio } from "@/lib/voice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const audio = formData.get("audio");
    if (!(audio instanceof File)) {
      return NextResponse.json({ error: "audio file is required" }, { status: 400 });
    }

    const { text, modelPath } = await transcribeAudio(
      Buffer.from(await audio.arrayBuffer()),
      audio.name,
    );
    return NextResponse.json({ text, modelPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to transcribe audio";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
