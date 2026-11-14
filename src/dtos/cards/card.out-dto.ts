import { AnswerType, Card, CardAnswer } from "@prisma/client";
import { GetFileUrl } from "src/utils/files.utils";
import { WithModelUrl } from "src/utils/model.utils";

export function CardOutDto(card: Card & { answers: CardAnswer[] }) {
    return {
        order: card.order,
        deck_id: card.deck_id,
        id: card.id,
        data: WithModelUrl(card.data),
        front_image_url: card.front_image_name
            ? GetFileUrl(card.front_image_name)
            : null,
        back_image_url: card.back_image_name
            ? GetFileUrl(card.back_image_name)
            : null,
        document_url: card.document_name
            ? GetFileUrl(card.document_name)
            : null,
        document_title: card.document_title,
        type: card.type,
        created_at: card.created_at,
        answer: card?.answers?.[0] ? card.answers[0].answer : AnswerType.NONE,
        answer_created_at: card?.answers?.[0] ? card.answers[0].created_at : new Date(0),
        answer_updated_at: card?.answers?.[0] ? card.answers[0].updated_at : new Date(0)
    };
}
