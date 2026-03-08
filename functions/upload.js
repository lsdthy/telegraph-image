import { errorHandling, telemetryData } from "./utils/middleware";

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const clonedRequest = request.clone();
        
        // 【新增】从请求 URL 中提取 album 参数（即相册名称）
        const reqUrl = new URL(clonedRequest.url);
        const albumName = reqUrl.searchParams.get('album') || "None";

        const formData = await clonedRequest.formData();

        await errorHandling(context);
        telemetryData(context);

        const uploadFile = formData.get('file');
        if (!uploadFile) {
            throw new Error('No file uploaded');
        }

        const fileName = uploadFile.name;
        const fileExtension = fileName.split('.').pop().toLowerCase();
        const fileType = uploadFile.type;
        const fileSize = uploadFile.size;
        
        const isImage = fileType.startsWith('image/');
        const fileBuffer = await uploadFile.arrayBuffer();
        const uploadTasks = [];

        if (isImage) {
            const docFormData = new FormData();
            docFormData.append("chat_id", env.TG_Chat_ID);
            docFormData.append("document", new Blob([fileBuffer], { type: fileType }), fileName);
            uploadTasks.push(uploadToTelegram(docFormData, 'sendDocument', env));

            if (fileSize <= 10 * 1024 * 1024) {
                const photoFormData = new FormData();
                photoFormData.append("chat_id", env.TG_Chat_ID);
                photoFormData.append("photo", new Blob([fileBuffer], { type: fileType }), fileName);
                uploadTasks.push(uploadToTelegram(photoFormData, 'sendPhoto', env));
            }
        } else {
            const otherFormData = new FormData();
            otherFormData.append("chat_id", env.TG_Chat_ID);
            let endpoint = 'sendDocument';
            
            if (fileType.startsWith('video/')) {
                otherFormData.append("video", new Blob([fileBuffer], { type: fileType }), fileName);
                endpoint = 'sendVideo';
            } else if (fileType.startsWith('audio/')) {
                otherFormData.append("audio", new Blob([fileBuffer], { type: fileType }), fileName);
                endpoint = 'sendAudio';
            } else {
                otherFormData.append("document", new Blob([fileBuffer], { type: fileType }), fileName);
            }
            uploadTasks.push(uploadToTelegram(otherFormData, endpoint, env));
        }

        const results = await Promise.all(uploadTasks);
        const responseDataArray = [];

        for (const result of results) {
            const fileId = getFileId(result.responseData, result.endpoint);
            if (!fileId) throw new Error(`Failed to get file ID for ${result.endpoint}`);

            let labelPrefix = "";
            if (isImage && results.length > 1) {
                labelPrefix = result.endpoint === 'sendDocument' ? "[原图] " : "[预览图] ";
            }

            if (env.img_url) {
                await env.img_url.put(`${fileId}.${fileExtension}`, "", {
                    metadata: {
                        TimeStamp: Date.now(),
                        ListType: albumName, // 【修改】这里不再是写死的 "None"，而是保存传入的相册名称
                        Label: albumName,
                        liked: false,
                        fileName: `${labelPrefix}${fileName}`,
                        fileSize: fileSize,
                    }
                });
            }
            responseDataArray.push({ 'src': `/file/${fileId}.${fileExtension}` });
        }

        return new Response(JSON.stringify(responseDataArray), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Upload error:', error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

// ============== 辅助函数 ==============
async function uploadToTelegram(formData, endpoint, env) {
    const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${endpoint}`;
    const response = await fetch(apiUrl, { method: "POST", body: formData });
    const responseData = await response.json();

    if (!response.ok) {
        throw new Error(responseData.description || `Upload via ${endpoint} failed`);
    }
    return { responseData, endpoint };
}

function getFileId(response, endpoint) {
    if (!response.ok || !response.result) return null;
    const result = response.result;
    
    if (endpoint === 'sendPhoto' && result.photo) {
        return result.photo.reduce((prev, current) => (prev.file_size > current.file_size) ? prev : current).file_id;
    } else if (endpoint === 'sendDocument' && result.document) {
        return result.document.file_id;
    } else if (endpoint === 'sendVideo' && result.video) {
        return result.video.file_id;
    } else if (endpoint === 'sendAudio' && result.audio) {
        return result.audio.file_id;
    }
    return null;
}
