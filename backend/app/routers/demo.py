from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.database import get_db
from app.services.demo_reset import reset_demo

router = APIRouter()


@router.post("/demo/reset", summary="Wipe campaigns, sequences, activity, briefs and AI research; preserve prospects")
def reset(db: Session = Depends(get_db)):
    result = reset_demo(db)
    return {"status": "reset_complete", **result}
