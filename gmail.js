require("dotenv").config();

const {google}=require("googleapis");
const fs=require("fs").promises;
const path=require("path");

const PROCESSED_FILE=path.join(
    process.cwd(),
    "processedEmails.json"
);

const oauth2Client=new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
);

oauth2Client.setCredentials({
    refresh_token:process.env.GOOGLE_REFRESH_TOKEN
});

const gmail=google.gmail({
    version:"v1",
    auth:oauth2Client
});


async function getProcessedEmails(){
    try{
        const content=await fs.readFile(
            PROCESSED_FILE,
            "utf-8"
        );

        return JSON.parse(content);
    }catch(error){
        return [];
    }
}


async function saveProcessedEmail(id){
    const emails=await getProcessedEmails();

    if(!emails.includes(id)){
        emails.push(id);

        await fs.writeFile(
            PROCESSED_FILE,
            JSON.stringify(
                emails,
                null,
                2
            )
        );
    }
}


function decodeBody(data){
    return Buffer.from(
        data,
        "base64url"
    ).toString("utf-8");
}


function getEmailBody(payload){

    if(
        payload.body &&
        payload.body.data
    ){
        return decodeBody(
            payload.body.data
        );
    }

    if(payload.parts){

        for(const part of payload.parts){

            if(
                part.mimeType==="text/plain" &&
                part.body &&
                part.body.data
            ){
                return decodeBody(
                    part.body.data
                );
            }

            if(part.parts){

                const body=
                    getEmailBody(part);

                if(body){
                    return body;
                }
            }
        }
    }

    return "";
}


async function sendToAI(subject,body){

    const response=await fetch(
        "http://localhost:3000/analyze-email",
        {
            method:"POST",

            headers:{
                "Content-Type":"application/json"
            },

            body:JSON.stringify({
                email:`
Subject: ${subject}

${body}
`
            })
        }
    );

    const data=await response.json();

    if(!response.ok){
        throw new Error(
            JSON.stringify(data)
        );
    }

    console.log("\n🤖 AI Result:");

    console.log(
        JSON.stringify(
            data,
            null,
            2
        )
    );
}


async function checkEmails(){

    try{

        const processedEmails=
            await getProcessedEmails();

        const result=
            await gmail.users.messages.list({
                userId:"me",
                maxResults:10
            });

        const messages=
            result.data.messages;

        if(
            !messages ||
            messages.length===0
        ){
            console.log(
                "📭 No emails found."
            );

            return;
        }


        for(const message of messages){

            if(
                processedEmails.includes(
                    message.id
                )
            ){
                continue;
            }


            console.log(
                "\n📧 New email detected!"
            );


            const email=
                await gmail.users.messages.get({
                    userId:"me",
                    id:message.id,
                    format:"full"
                });


            const headers=
                email.data.payload.headers;


            const subject=
                headers.find(
                    h=>
                    h.name.toLowerCase()==="subject"
                );


            const from=
                headers.find(
                    h=>
                    h.name.toLowerCase()==="from"
                );


            const body=
                getEmailBody(
                    email.data.payload
                );


            console.log(
                "From:",
                from?.value
            );


            console.log(
                "Subject:",
                subject?.value
            );


            console.log(
                "Body:",
                body
            );


            try{

                await sendToAI(
                    subject?.value || "",
                    body
                );


                await saveProcessedEmail(
                    message.id
                );


                console.log(
                    "✅ Email processed."
                );

            }catch(error){

                console.error(
                    "❌ AI processing failed:",
                    error.message
                );

                console.log(
                    "⚠️ Email will be retried."
                );
            }
        }

    }catch(error){

        console.error(
            "❌ Gmail check failed:",
            error.message
        );
    }
}


async function startMonitoring(){

    console.log(
        "\n🚀 AI Email Caller started!"
    );

    console.log(
        "🔐 Using Google OAuth refresh token..."
    );

    console.log(
        "👀 Monitoring Gmail for new emails..."
    );


    // Check immediately
    await checkEmails();


    // Check every 30 seconds
    setInterval(
        async()=>{
            console.log(
                "\n🔍 Checking for new emails..."
            );

            await checkEmails();

        },
        30*1000
    );
}


startMonitoring();