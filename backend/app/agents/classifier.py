from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import JsonOutputParser
from sqlalchemy.orm import Session
from app.agents.base import get_llm
from app.models.email_sequence import EmailSequence


CLASSIFIER_SYSTEM = """You are a sales operations AI that classifies inbound email replies.

Classify the reply into exactly one of these categories:
- positive: Clear interest, wants to proceed, asks for demo/pricing/call
- neutral: Acknowledges, non-committal, asks general questions
- objection: Raises specific concern (price, timing, competitor, contract)
- ooo: Out of office auto-reply
- unsubscribe: Explicitly asks to be removed from outreach

Return ONLY valid JSON:
{{
  "classification": "positive|neutral|objection|ooo|unsubscribe",
  "confidence": 0.0-1.0,
  "sub_type": "brief description (e.g. 'price_concern', 'timing_issue', 'interested_next_quarter')",
  "key_signals": ["signal1", "signal2"],
  "suggested_response_snippet": "A 1-sentence suggested follow-up opener (leave blank for unsubscribe/ooo)"
}}"""

CLASSIFIER_HUMAN = """Original email subject: {original_subject}

Reply text:
{reply_text}

Classify this reply."""


class ClassifierAgent:
    async def classify(self, reply_text: str, sequence_id: int, db: Session) -> dict:
        llm = get_llm(temperature=0.1, agent="classifier")
        parser = JsonOutputParser()

        original_subject = ""
        seq = db.query(EmailSequence).filter(EmailSequence.id == sequence_id).first()
        if seq:
            original_subject = seq.subject

        prompt = ChatPromptTemplate.from_messages([
            ("system", CLASSIFIER_SYSTEM),
            ("human", CLASSIFIER_HUMAN),
        ])

        chain = prompt | llm | parser

        result = await chain.ainvoke({
            "original_subject": original_subject,
            "reply_text": reply_text,
        })
        return result


classifier_agent = ClassifierAgent()
