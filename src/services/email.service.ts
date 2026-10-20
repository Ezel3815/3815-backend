import { Injectable } from "@nestjs/common";
import { User } from "@prisma/client";

@Injectable()
export class EmailService {
    private async send(
        to: string,
        subject: string,
        text: string,
    ): Promise<boolean> {
        try {
            const response = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    from: process.env.EMAIL_FROM || "onboarding@resend.dev",
                    to: [to],
                    subject,
                    text,
                }),
            });
            if (!response.ok) {
                console.error("Error sending email", await response.text());
                return false;
            }
            return true;
        } catch (e) {
            console.error("Error sending email", e);
            return false;
        }
    }

    /** Plain notification (used by the pipeline when a job finishes). */
    async notify(to: string, subject: string, text: string) {
        return await this.send(to, subject, text);
    }

    async sendVerificationEmail(user: User) {
        return await this.send(
            user.email,
            "Verification code",
            `Hello ${user.name} Your verification code is ${user.activation_code}`,
        );
    }

    async sendResetPasswordEmail(user: User) {
        return await this.send(
            user.email,
            "Verification code",
            `Hello ${user.name} Your reset password code is ${user.reset_password_code}`,
        );
    }
}
