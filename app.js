require("dotenv").config();

const express=require("express");
const mongoose=require("mongoose");
const {google}=require("googleapis");
const {GoogleGenerativeAI}=require("@google/generative-ai");

const app=express();

app.use(express.json());

const PORT=process.env.PORT||3000;


// ===============================
// ENVIRONMENT VARIABLES
// ===============================

const requiredEnv=[
    "GEMINI_API_KEY",
    "EDESY_API_KEY",
    "EDESY_AGENT_ID",
    "MY_PHONE_NUMBER",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
    "MONGODB_URI"
];

for(const variable of requiredEnv){

    if(!process.env[variable]){

        console.error(
            `❌ Missing environment variable: ${variable}`
        );

        process.exit(1);
    }
}


// ===============================
// GEMINI
// ===============================

const genAI=new GoogleGenerativeAI(
    process.env.GEMINI_API_KEY
);

const model=genAI.getGenerativeModel({
    model:"gemini-2.5-flash"
});


// Gemini cooldown

let geminiCooldownUntil=0;


// ===============================
// MONGODB
// ===============================

const processedEmailSchema=new mongoose.Schema({

    messageId:{
        type:String,
        required:true,
        unique:true
    },

    subject:String,

    from:String,

    processedAt:{
        type:Date,
        default:Date.now
    },

    requiresCall:{
        type:Boolean,
        default:false
    }

});

const ProcessedEmail=mongoose.model(
    "ProcessedEmail",
    processedEmailSchema
);


// ===============================
// GOOGLE OAUTH
// ===============================

const oauth2Client=new google.auth.OAuth2(

    process.env.GOOGLE_CLIENT_ID,

    process.env.GOOGLE_CLIENT_SECRET

);

oauth2Client.setCredentials({

    refresh_token:
        process.env.GOOGLE_REFRESH_TOKEN

});


const gmail=google.gmail({

    version:"v1",

    auth:oauth2Client

});


// ===============================
// BASE64 DECODER
// ===============================

function decodeBase64(data){

    if(!data){
        return "";
    }

    return Buffer
        .from(
            data.replace(/-/g,"+").replace(/_/g,"/"),
            "base64"
        )
        .toString("utf-8");

}


// ===============================
// EXTRACT EMAIL BODY
// ===============================

function extractBody(payload){

    if(!payload){
        return "";
    }


    if(
        payload.mimeType==="text/plain" &&
        payload.body &&
        payload.body.data
    ){

        return decodeBase64(
            payload.body.data
        );

    }


    if(payload.parts){

        for(const part of payload.parts){

            const body=extractBody(part);

            if(body){
                return body;
            }

        }

    }


    return "";

}


// ===============================
// GET EMAIL HEADER
// ===============================

function getHeader(headers,name){

    if(!headers){
        return "";
    }

    const header=headers.find(

        h=>
            h.name.toLowerCase()===
            name.toLowerCase()

    );

    return header
        ? header.value
        : "";

}


// ===============================
// GEMINI ANALYSIS
// ===============================

async function analyzeEmail(email){

    // Check Gemini cooldown

    if(Date.now()<geminiCooldownUntil){

        const remaining=Math.ceil(

            (
                geminiCooldownUntil-
                Date.now()
            )/1000

        );

        throw new Error(
            `Gemini quota cooldown active. Retry in ${remaining}s.`
        );

    }


    console.log(
        "🤖 Sending email to Gemini..."
    );


    const prompt=`

You are an AI email assistant whose job is to decide whether the user should receive a phone call about an email.

Analyze the email carefully.

An email SHOULD require a phone call if:

- It is urgent
- It contains an interview
- It contains a job opportunity
- It contains an important deadline
- It contains a meeting
- It contains an appointment
- It contains an important payment issue
- It contains a security alert
- It contains an important personal matter
- The user needs to take action soon
- Missing the email could cause a significant problem

An email should NOT require a call if:

- It is a newsletter
- It is promotional
- It is advertising
- It is a normal notification
- It is unimportant
- No action is required

Return ONLY valid JSON.

Use this exact structure:

{
    "important":true,
    "priority":"high",
    "category":"job",
    "summary":"short summary",
    "requires_call":true
}

Priority must be one of:

"high"
"medium"
"low"

Do not include markdown.

Email:

${email}

`;


    try{

        const result=
            await model.generateContent(
                prompt
            );


        let response=
            result.response.text().trim();


        response=response.replace(
            /^```json\s*/,
            ""
        );

        response=response.replace(
            /^```\s*/,
            ""
        );

        response=response.replace(
            /\s*```$/,
            ""
        );


        return JSON.parse(response);

    }catch(error){

        // Gemini quota error

        if(
            error.message.includes("429") ||
            error.message.includes("quota") ||
            error.message.includes("Too Many Requests")
        ){

            console.error(
                "🚫 Gemini quota exceeded."
            );


            // Default 60 second cooldown

            let cooldown=60000;


            // Try to extract Google's retry time

            const match=
                error.message.match(
                    /retryDelay[":\s]+["']?(\d+)s/
                );


            if(match){

                cooldown=
                    (Number(match[1])+5)*
                    1000;

            }


            geminiCooldownUntil=
                Date.now()+cooldown;


            console.log(
                `⏸️ Gemini paused for ${Math.ceil(cooldown/1000)} seconds.`
            );

        }


        throw error;

    }

}


// ===============================
// EDESY CALL
// ===============================

async function makeCall(summary){

    console.log(
        "📞 Calling your phone..."
    );


    const response=await fetch(

        "https://voice-agent.edesy.in/api/v1/calls",

        {

            method:"POST",

            headers:{

                "Content-Type":
                    "application/json",

                "Authorization":
                    `Bearer ${process.env.EDESY_API_KEY}`

            },

            body:JSON.stringify({

                agentId:
                    Number(
                        process.env.EDESY_AGENT_ID
                    ),

                phoneNumber:
                    process.env.MY_PHONE_NUMBER,

                variables:{

                    email_summary:
                        summary

                }

            })

        }

    );


    const data=
        await response.json();


    if(!response.ok){

        throw new Error(
            JSON.stringify(data)
        );

    }


    return data;

}


// ===============================
// PROCESS EMAIL
// ===============================

async function processEmail(message){

    const messageId=message.id;


    // ===============================
    // CHECK MONGODB
    // ===============================

    const alreadyProcessed=
        await ProcessedEmail.findOne({

            messageId:messageId

        });


    if(alreadyProcessed){

        return;

    }


    // ===============================
    // GET EMAIL
    // ===============================

    const emailData=
        await gmail.users.messages.get({

            userId:"me",

            id:messageId,

            format:"full"

        });


    const payload=
        emailData.data.payload;


    const headers=
        payload.headers||[];


    const from=
        getHeader(
            headers,
            "From"
        );


    const subject=
        getHeader(
            headers,
            "Subject"
        );


    const body=
        extractBody(payload);


    const emailText=`

From: ${from}

Subject: ${subject}

Body:

${body}

`;


    console.log("\n📧 New Email");

    console.log(
        `From: ${from}`
    );

    console.log(
        `Subject: ${subject}`
    );


    // ===============================
    // SAVE BEFORE GEMINI
    // ===============================

    try{

        await ProcessedEmail.create({

            messageId:messageId,

            subject:subject,

            from:from,

            requiresCall:false

        });

    }catch(error){

        // Duplicate key means another
        // process already saved it

        if(error.code===11000){

            console.log(
                "⏭️ Email already saved."
            );

            return;

        }

        throw error;

    }


    // ===============================
    // GEMINI
    // ===============================

    try{

        const analysis=
            await analyzeEmail(
                emailText
            );


        console.log(
            "\n🤖 Gemini Analysis:"
        );


        console.log(

            JSON.stringify(
                analysis,
                null,
                2
            )

        );


        // ===============================
        // UPDATE DATABASE
        // ===============================

        await ProcessedEmail.updateOne(

            {
                messageId:messageId
            },

            {

                $set:{

                    requiresCall:
                        analysis.requires_call===true

                }

            }

        );


        // ===============================
        // EDESY
        // ===============================

        if(
            analysis.requires_call===true
        ){

            console.log(
                "\n📞 Important email detected!"
            );


            try{

                const callResult=
                    await makeCall(
                        analysis.summary
                    );


                console.log(
                    "✅ Edesy call initiated"
                );


                console.log(

                    JSON.stringify(
                        callResult,
                        null,
                        2
                    )

                );

            }catch(error){

                console.error(
                    "❌ Edesy call failed:",
                    error.message
                );

            }

        }else{

            console.log(
                "ℹ️ Email is not important. No call."
            );

        }


        console.log(
            "✅ Email processed."
        );


    }catch(error){

        console.error(
            "❌ Email processing failed:",
            error.message
        );

    }

}


// ===============================
// CHECK GMAIL
// ===============================

let checking=false;


async function checkEmails(){

    if(checking){

        return;

    }


    // Don't even fetch/process emails
    // while Gemini is in cooldown

    if(Date.now()<geminiCooldownUntil){

        const remaining=Math.ceil(

            (
                geminiCooldownUntil-
                Date.now()
            )/1000

        );

        console.log(
            `⏸️ Gemini quota cooldown: ${remaining}s remaining`
        );

        return;

    }


    checking=true;


    try{

        const response=
            await gmail.users.messages.list({

                userId:"me",

                maxResults:10

            });


        const messages=
            response.data.messages||[];


        if(messages.length===0){

            console.log(
                "📭 No emails found."
            );

            return;

        }


        for(const message of messages){

            // Stop immediately if Gemini
            // hits quota

            if(
                Date.now()<
                geminiCooldownUntil
            ){

                break;

            }


            await processEmail(
                message
            );

        }


    }catch(error){

        console.error(
            "❌ Gmail check failed:",
            error.message
        );

    }finally{

        checking=false;

    }

}


// ===============================
// HEALTH CHECK
// ===============================

app.get("/",(req,res)=>{

    res.json({

        status:"running",

        service:"AI Email Caller",

        mongodb:
            mongoose.connection.readyState===1
                ? "connected"
                : "disconnected",

        gemini:
            Date.now()<geminiCooldownUntil
                ? "cooldown"
                : "available"

    });

});


// ===============================
// START SERVER
// ===============================

async function startServer(){

    try{

        console.log(
            "🔌 Connecting to MongoDB..."
        );


        await mongoose.connect(
            process.env.MONGODB_URI
        );


        console.log(
            "🍃 MongoDB connected"
        );


        app.listen(

            PORT,

            async()=>{

                console.log(
                    `🌐 Server running on port ${PORT}`
                );

                console.log(
                    "🚀 AI Email Caller started!"
                );

                console.log(
                    "🔐 Using Google OAuth refresh token..."
                );

                console.log(
                    "👀 Monitoring Gmail..."
                );


                await checkEmails();


                setInterval(

                    checkEmails,

                    30000

                );

            }

        );


    }catch(error){

        console.error(
            "❌ MongoDB connection failed:",
            error.message
        );


        process.exit(1);

    }

}


startServer();