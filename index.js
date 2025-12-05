import { exec } from "child_process";
import cors from "cors";
import dotenv from "dotenv";
import voice from "elevenlabs-node";
import express from "express";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const audiosDir = path.join(__dirname, "audios");
const rhubarbPath = path.join(__dirname, "bin", "rhubarb");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "-", // Your OpenAI API key here, I used "-" to avoid errors when the key is not set but you should not do that
});

const elevenLabsApiKey = process.env.ELEVEN_LABS_API_KEY;
const voiceID = "kgG7dCoKCfLehAPWkJOE";

const app = express();
app.use(express.json());
app.use(cors());
const port = 3000;

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.get("/voices", async (req, res) => {
  res.send(await voice.getVoices(elevenLabsApiKey));
});

const execCommand = (command) => {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) reject(error);
      resolve(stdout);
    });
  });
};

const lipSyncMessage = async (message) => {
  const time = new Date().getTime();
  console.log(`Starting conversion for message ${message}`);
  const mp3 = path.join(audiosDir, `message_${message}.mp3`);
  const wav = path.join(audiosDir, `message_${message}.wav`);
  const json = path.join(audiosDir, `message_${message}.json`);
  await execCommand(`ffmpeg -y -i "${mp3}" "${wav}"`);
  console.log(`Conversion done in ${new Date().getTime() - time}ms`);
  await execCommand(`"${rhubarbPath}" -f json -o "${json}" "${wav}" -r phonetic`);
  // -r phonetic is faster but less accurate
  console.log(`Lip sync done in ${new Date().getTime() - time}ms`);
};
app.get("/omid", (req, res) => {
  res.send("Hello World");
});
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;
    if (!userMessage) {
      res.send({
        messages: [
          {
            text: "Hey dear... How was your day?",
            audio: await audioFileToBase64(path.join(audiosDir, "intro_0.wav")),
            lipsync: await readJsonTranscript(path.join(audiosDir, "intro_0.json")),
            facialExpression: "smile",
            animation: "Talking_1",
          },
          {
            text: "I missed you so much... Please don't go for so long!",
            audio: await audioFileToBase64(path.join(audiosDir, "intro_1.wav")),
            lipsync: await readJsonTranscript(path.join(audiosDir, "intro_1.json")),
            facialExpression: "sad",
            animation: "Crying",
          },
        ],
      });
      return;
    }

    if (!elevenLabsApiKey || openai.apiKey === "-") {
      res.send({
        messages: [
          {
            text: "Please my dear, don't forget to add your API keys!",
            audio: await audioFileToBase64(path.join(audiosDir, "api_0.wav")),
            lipsync: await readJsonTranscript(path.join(audiosDir, "api_0.json")),
            facialExpression: "angry",
            animation: "Angry",
          },
          {
            text: "You don't want to ruin Wawa Sensei with a crazy ChatGPT and ElevenLabs bill, right?",
            audio: await audioFileToBase64(path.join(audiosDir, "api_1.wav")),
            lipsync: await readJsonTranscript(path.join(audiosDir, "api_1.json")),
            facialExpression: "smile",
            animation: "Laughing",
          },
        ],
      });
      return;
    }

    // Ensure required directories exist
    await fs.mkdir(audiosDir, { recursive: true });

    // Ensure rhubarb binary exists
    try {
      await fs.access(rhubarbPath);
    } catch (err) {
      res.status(500).send({
        error: "Rhubarb not found",
        details: `Expected executable at ${rhubarbPath}`,
      });
      return;
    }

    let completion;
    try {
      completion = await openai.chat.completions.create({
        model: "gpt-3.5-turbo-1106",
        max_tokens: 1000,
        temperature: 0.6,
        response_format: {
          type: "json_object",
        },
        messages: [
          {
            role: "system",
            content: `
            You are a virtual girlfriend.
            You will always reply with a JSON array of messages. With a maximum of 3 messages.
            Each message has a text, facialExpression, and animation property.
            The different facial expressions are: smile, sad, angry, surprised, funnyFace, and default.
            The different animations are: Talking_0, Talking_1, Talking_2, Crying, Laughing, Rumba, Idle, Terrified, and Angry. 
            `,
          },
          {
            role: "user",
            content: userMessage || "Hello",
          },
        ],
      });
    } catch (err) {
      console.error("OpenAI error:", err?.message || err);
      res.status(502).send({
        error: "OpenAI request failed",
        details: err?.message || String(err),
      });
      return;
    }

    let messages = {};
    try {
      messages = JSON.parse(completion.choices[0].message.content);
    } catch (err) {
      console.error("Failed to parse OpenAI JSON:", err?.message || err);
      res.status(500).send({
        error: "Failed to parse OpenAI response",
        details: err?.message || String(err),
      });
      return;
    }
    if (messages.messages) {
      messages = messages.messages; // Normalize to array
    }

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const fileName = path.join(audiosDir, `message_${i}.mp3`);
      const textInput = message.text;
      try {
        await voice.textToSpeech(elevenLabsApiKey, voiceID, fileName, textInput);
      } catch (err) {
        console.error("ElevenLabs TTS error:", err?.message || err);
        res.status(502).send({
          error: "Text-to-speech failed",
          details: err?.message || String(err),
        });
        return;
      }

      // Verify the MP3 file was actually created before proceeding
      try {
        await fs.access(fileName);
      } catch (err) {
        console.error("TTS output missing:", fileName);
        res.status(502).send({
          error: "Text-to-speech output missing",
          details: `Expected file not found: ${fileName}`,
        });
        return;
      }

      try {
        await lipSyncMessage(i);
      } catch (err) {
        console.error("Rhubarb/ffmpeg error:", err?.message || err);
        res.status(500).send({
          error: "Lip-sync generation failed",
          details: err?.message || String(err),
        });
        return;
      }

      message.audio = await audioFileToBase64(fileName);
      message.lipsync = await readJsonTranscript(path.join(audiosDir, `message_${i}.json`));
    }

    res.send({ messages });
  } catch (err) {
    console.error("Unhandled /chat error:", err?.message || err);
    res.status(500).send({ error: "Internal server error", details: err?.message || String(err) });
  }
});

const readJsonTranscript = async (file) => {
  const data = await fs.readFile(file, "utf8");
  return JSON.parse(data);
};

const audioFileToBase64 = async (file) => {
  const data = await fs.readFile(file);
  return data.toString("base64");
};

app.listen(port, () => {
  console.log(`Virtual Girlfriend listening on port ${port}`);
});
