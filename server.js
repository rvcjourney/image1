require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname), { extensions: ['html'], redirect: false }));

const REPLICATE_BASE   = 'https://api.replicate.com/v1';
const REPLICATE_TOKEN  = process.env.REPLICATE_TOKEN;
const KLING_ACCESS_KEY = process.env.KLING_ACCESS_KEY;
const KLING_SECRET_KEY = process.env.KLING_SECRET_KEY;
const GEMINI_TOKEN     = process.env.GEMINI_TOKEN;
const CLAUDE_TOKEN     = process.env.CLAUDE_TOKEN;

function generateKlingJWT() {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
        { iss: KLING_ACCESS_KEY, exp: now + 1800, nbf: now - 5 },
        KLING_SECRET_KEY,
        { algorithm: 'HS256' }
    );
}

// ── Kling AI: generate image (server-side polling) ───────────────────────────
app.post('/proxy/kling/generate', async (req, res) => {
    try {
        const { prompt, model, aspect_ratio, negative_prompt } = req.body;
        const token = generateKlingJWT();

        const requestBody = {
            model: model || 'kling-v1',
            prompt,
            negative_prompt: negative_prompt || '',
            aspect_ratio: aspect_ratio || '1:1',
            n: 1
        };
        console.log('Kling request body:', JSON.stringify(requestBody));

        // Step 1: Submit job
        const submitRes = await fetch('https://api.klingai.com/v1/images/generations', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        const submitData = await submitRes.json();
        console.log('Kling submit:', JSON.stringify(submitData));
        if (!submitRes.ok) return res.status(submitRes.status).json(submitData);

        const taskId = submitData?.data?.task_id;
        if (!taskId) return res.status(500).json({ error: 'No task_id', raw: submitData });

        // Step 2: Poll every 3s (max 2 minutes)
        for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const freshToken = generateKlingJWT();

            const pollRes = await fetch(`https://api.klingai.com/v1/images/generations/${taskId}`, {
                headers: { 'Authorization': `Bearer ${freshToken}` }
            });

            const pollData = await pollRes.json();
            const status = pollData?.data?.task_status || pollData?.task_status;
            console.log(`Kling poll ${i + 1}: status=${status} code=${pollData?.code}`);

            if (pollData?.code !== 0) continue; // skip non-success responses

            if (status === 'succeed') {
                const imgUrl = pollData?.data?.task_result?.images?.[0]?.url
                    || pollData?.data?.task_result?.images?.[0]?.resource_without_watermark;
                if (imgUrl) return res.json({ url: imgUrl });
                return res.status(500).json({ error: 'No image URL', raw: pollData });
            }
            if (status === 'failed') {
                return res.status(500).json({ error: 'Generation failed', raw: pollData });
            }
        }

        res.status(504).json({ error: 'Timeout' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Claude: generate SVG ─────────────────────────────────────────────────────
app.post('/proxy/claude/generate', async (req, res) => {
    try {
        const { prompt, model, logoData, productData } = req.body;

        const format = req.body.format || 'svg';

        const imageInstructions = [
            logoData    ? '- A logo image is provided. Embed it using a base64 data URL in an <image> tag (SVG) or drawImage (Canvas). Place it exactly as described in the prompt.' : '',
            productData ? '- A product image is provided. Embed it using a base64 data URL in an <image> tag (SVG) or drawImage (Canvas). Place it exactly as described in the prompt.' : ''
        ].filter(Boolean).join('\n');

        const systemPrompt = format === 'canvas'
        ? `You are an expert HTML Canvas designer specializing in marketing cards and ad creatives.
When given a design prompt, respond with ONLY a complete self-contained HTML page that:
- Has a <canvas id="c" width="1024" height="1024"> element
- Draws the entire design using Canvas 2D API in a <script> tag
- Renders ALL text exactly as specified — no paraphrasing or shortening
- Uses clean professional fonts (Arial, Helvetica, sans-serif)
- Produces a premium marketing card layout with precise positioning
- No external dependencies, no imports, works offline
- Do NOT include any explanation, comments outside code, or markdown
- Output raw HTML only, starting with <!DOCTYPE html>
${imageInstructions}`
        : `You are an expert SVG designer specializing in marketing cards and ad creatives.
When given a design prompt, you MUST respond with ONLY a complete, valid SVG code — nothing else.
No explanation, no markdown, no code blocks. Just raw SVG starting with <svg and ending with </svg>.
Requirements:
- Always use viewBox="0 0 1024 1024" for square format
- Use embedded fonts via @font-face or system fonts like Arial, Helvetica
- Render ALL text exactly as specified in the prompt — no paraphrasing
- Use precise positioning, clean layout, professional typography
- Make it look like a premium marketing card
- All text must be clearly readable and properly placed
${imageInstructions}`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': CLAUDE_TOKEN,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                model: model || 'claude-sonnet-4-6',
                max_tokens: 8000,
                system: systemPrompt,
                messages: [{
                    role: 'user',
                    content: [
                        ...(logoData    ? [{ type: 'image', source: { type: 'base64', media_type: logoData.mimeType,    data: logoData.base64    } }] : []),
                        ...(productData ? [{ type: 'image', source: { type: 'base64', media_type: productData.mimeType, data: productData.base64 } }] : []),
                        {
                            type: 'text',
                            text: [
                                logoData    ? `LOGO_DATA_URL: data:${logoData.mimeType};base64,${logoData.base64}` : '',
                                productData ? `PRODUCT_DATA_URL: data:${productData.mimeType};base64,${productData.base64}` : '',
                                logoData    ? 'Use the LOGO_DATA_URL above as the src/href for the logo image element in your output code.' : '',
                                productData ? 'Use the PRODUCT_DATA_URL above as the src/href for the product image element in your output code.' : '',
                                prompt
                            ].filter(Boolean).join('\n\n')
                        }
                    ]
                }]
            })
        });

        const data = await response.json();
        console.log('Claude response status:', response.status);

        if (!response.ok) return res.status(response.status).json(data);

        const text = data?.content?.[0]?.text || '';

        if (format === 'canvas') {
            const htmlMatch = text.match(/<!DOCTYPE[\s\S]*<\/html>/i) || text.match(/<html[\s\S]*<\/html>/i);
            if (!htmlMatch) return res.status(500).json({ error: 'No HTML in response', raw: text.substring(0, 500) });
            return res.json({ html: htmlMatch[0], format: 'canvas' });
        }

        // Extract SVG from response
        const svgMatch = text.match(/<svg[\s\S]*<\/svg>/i);
        if (!svgMatch) return res.status(500).json({ error: 'No SVG in response', raw: text.substring(0, 500) });

        res.json({ svg: svgMatch[0], format: 'svg' });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Gemini: rate-limit guard (max 1 req per 35s) ─────────────────────────────
let geminiLastCall = 0;
const GEMINI_MIN_INTERVAL = 35000; // 35 seconds between calls

// ── Gemini: generate image ────────────────────────────────────────────────────
app.post('/proxy/gemini/generate', async (req, res) => {
    const now = Date.now();
    const wait = GEMINI_MIN_INTERVAL - (now - geminiLastCall);
    if (wait > 0) {
        await new Promise(r => setTimeout(r, wait));
    }
    geminiLastCall = Date.now();
    try {
        const { prompt, model, logoData, productData } = req.body;
        const modelId = model || 'gemini-2.5-flash-image';

        const parts = [];
        // Product image first — anchors canvas size/proportions
        if (productData) {
            parts.push({ inlineData: { mimeType: productData.mimeType, data: productData.base64 } });
        }
        // Logo second — reference for placement
        if (logoData) {
            parts.push({ inlineData: { mimeType: logoData.mimeType, data: logoData.base64 } });
        }
        parts.push({ text: prompt });

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${GEMINI_TOKEN}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts }],
                    generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
                })
            }
        );

        const data = await response.json();
        console.log('Gemini response status:', response.status);

        if (!response.ok) return res.status(response.status).json(data);

        // Extract base64 image from response
        const responseParts = data?.candidates?.[0]?.content?.parts || [];
        const imagePart = responseParts.find(p => p.inlineData);

        if (!imagePart) return res.status(500).json({ error: 'No image in response', raw: data });

        res.json({
            b64: imagePart.inlineData.data,
            mimeType: imagePart.inlineData.mimeType || 'image/png'
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Replicate: generate image (server-side polling) ──────────────────────────

app.post('/proxy/replicate/generate', async (req, res) => {
    try {
        const { prompt, model, width, height, aspect_ratio, output_format, seedream_size, logoData, productData } = req.body;

        // Step 1: Submit prediction
        const modelMap = {
            'flux-2-max':          'black-forest-labs/flux-2-max',
            'flux-2-pro':          'black-forest-labs/flux-2-pro',
            'flux-2-flex':         'black-forest-labs/flux-2-flex',
            'flux-1.1-pro':        'black-forest-labs/flux-1.1-pro',
            'flux-pro':            'black-forest-labs/flux-pro',
            'flux-dev':            'black-forest-labs/flux-dev',
            'flux-schnell':        'black-forest-labs/flux-schnell',
            'seedream-4':          'bytedance/seedream-4',
            'seedream-4.5':        'bytedance/seedream-4.5',
            'seedream-5':          'bytedance/seedream-5',
            'seedream-5-lite':     'bytedance/seedream-5-lite',
            'ideogram-v3-turbo':   'ideogram-ai/ideogram-v3-turbo',
            'recraft-v4':          'recraft-ai/recraft-v4',
            'recraft-v4-svg':      'recraft-ai/recraft-v4-svg',
            'gemini-2.5-flash-image': 'google/gemini-2.5-flash-image',
            'nano-banana':            'google/nano-banana',
            'nano-banana-2':          'google/nano-banana-2',
            'nano-banana-pro':        'google/nano-banana-pro',
            'imagen-4-ultra':         'google/imagen-4-ultra',
            'imagen-4':               'google/imagen-4',
            'imagen-4-fast':          'google/imagen-4-fast',
            'imagen-3':               'google/imagen-3',
            'imagen-3-fast':          'google/imagen-3-fast'
        };
        const replicateModel = modelMap[model] || 'black-forest-labs/flux-1.1-pro';

        // Models that support image input and how they accept it
        // Image input field names per model
        const supportsImageField    = ['flux-dev', 'flux-schnell', 'recraft-v4-svg'];
        const supportsSeedreamImage = ['seedream-4', 'seedream-4.5', 'seedream-5', 'seedream-5-lite'];
        const supportsInputImages   = ['flux-2-pro', 'flux-2-max', 'flux-2-flex']; // correct field: input_images
        const supportsStyleRef      = ['ideogram-v3-turbo', 'recraft-v4'];
        const noImageSupport        = ['flux-1.1-pro', 'flux-pro', 'gemini-2.5-flash-image', 'nano-banana', 'nano-banana-2', 'nano-banana-pro', 'imagen-4', 'imagen-4-fast', 'imagen-4-ultra', 'imagen-3', 'imagen-3-fast'];
        const noWidthHeight         = ['flux-2-pro', 'flux-2-max', 'flux-2-flex', 'seedream-4', 'seedream-4.5', 'seedream-5', 'seedream-5-lite', 'ideogram-v3-turbo', 'recraft-v4', 'recraft-v4-svg', 'gemini-2.5-flash-image', 'nano-banana', 'nano-banana-2', 'nano-banana-pro', 'imagen-4', 'imagen-4-fast', 'imagen-4-ultra', 'imagen-3', 'imagen-3-fast'];
        const noOutputFormat        = ['ideogram-v3-turbo', 'recraft-v4', 'recraft-v4-svg', 'seedream-4', 'seedream-4.5', 'seedream-5', 'seedream-5-lite', 'gemini-2.5-flash-image', 'nano-banana', 'nano-banana-2', 'nano-banana-pro', 'imagen-4', 'imagen-4-fast', 'imagen-4-ultra', 'imagen-3', 'imagen-3-fast'];

        const input = { prompt, aspect_ratio: aspect_ratio || '1:1' };

        if (!noWidthHeight.includes(model)) {
            input.width  = width  || 1024;
            input.height = height || 1024;
        }
        if (!noOutputFormat.includes(model)) {
            input.output_format  = output_format || 'webp';
            input.output_quality = 80;
        }

        // Seedream-specific params
        if (supportsSeedreamImage.includes(model)) {
            input.size       = seedream_size || '2K';
            input.max_images = 1;
        }

        // Flux 2 safety tolerance
        if (supportsInputImages.includes(model)) {
            input.safety_tolerance = 2;
        }

        // Attach images based on what each model supports
        const rawImages = [];
        if (logoData)    rawImages.push(logoData);
        if (productData) rawImages.push(productData);

        if (rawImages.length > 0) {
            if (supportsInputImages.includes(model)) {
                input.input_images = rawImages.map(img => `data:${img.mimeType};base64,${img.base64}`);
                input.resolution   = '1 MP';
            } else if (supportsSeedreamImage.includes(model)) {
                input.image_input = rawImages.map(img => `data:${img.mimeType};base64,${img.base64}`);
            } else if (supportsImageField.includes(model)) {
                input.image = `data:${rawImages[0].mimeType};base64,${rawImages[0].base64}`;
            } else if (supportsStyleRef.includes(model)) {
                input.style_reference_images = rawImages.map(img => `data:${img.mimeType};base64,${img.base64}`);
            } else if (noImageSupport.includes(model)) {
                const imgContext = [
                    logoData    ? `Include a company logo placed as specified. Logo file: ${logoData.name || 'logo'}.` : '',
                    productData ? `Feature the product image prominently as specified. Product file: ${productData.name || 'product'}.` : ''
                ].filter(Boolean).join(' ');
                input.prompt = imgContext ? `${imgContext} ${prompt}` : prompt;
            }
        }

        const submitRes = await fetch(`${REPLICATE_BASE}/models/${replicateModel}/predictions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${REPLICATE_TOKEN}`,
                'Content-Type': 'application/json',
                'Prefer': 'wait'
            },
            body: JSON.stringify({ input })
        });

        const submitData = await submitRes.json();
        if (!submitRes.ok) return res.status(submitRes.status).json(submitData);

        // If Prefer:wait returned output directly
        if (submitData.output) {
            const imgUrl = Array.isArray(submitData.output) ? submitData.output[0] : submitData.output;
            return res.json({ url: imgUrl });
        }

        const predictionId = submitData.id;
        if (!predictionId) return res.status(500).json({ error: 'No prediction id', raw: submitData });

        // Step 2: Poll every 4s (max 6 minutes)
        for (let i = 0; i < 90; i++) {
            await new Promise(r => setTimeout(r, 4000));

            const pollRes = await fetch(`${REPLICATE_BASE}/predictions/${predictionId}`, {
                headers: { 'Authorization': `Bearer ${REPLICATE_TOKEN}` }
            });

            const pollData = await pollRes.json();
            console.log(`Replicate poll ${i + 1}: status=${pollData.status}`);

            if (pollData.status === 'succeeded') {
                const imgUrl = Array.isArray(pollData.output) ? pollData.output[0] : pollData.output;
                return res.json({ url: imgUrl });
            }
            if (pollData.status === 'failed' || pollData.status === 'canceled') {
                return res.status(500).json({ error: 'Generation failed', raw: pollData });
            }
        }

        res.status(504).json({ error: 'Timeout' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});




app.get('/favicon.ico', (req, res) => res.status(204).end());

const PORT = 4000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Open http://localhost:${PORT}/imagemodel.html`);
});
