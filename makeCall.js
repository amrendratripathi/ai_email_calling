async function makeCall(summary){

    const response=await fetch(
        "https://voice-agent.edesy.in/api/v1/calls",
        {
            method:"POST",

            headers:{
                "Content-Type":"application/json",
                "Authorization":`Bearer ${process.env.EDESY_API_KEY}`
            },

            body:JSON.stringify({
                agentId:Number(process.env.EDESY_AGENT_ID),
                phoneNumber:process.env.MY_PHONE_NUMBER,

                variables:{
                    email_summary:summary
                }
            })
        }
    );

    const data=await response.json();

    if(!response.ok){
        throw new Error(JSON.stringify(data));
    }

    return data;
}