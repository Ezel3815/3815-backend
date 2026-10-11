import { Equals } from "class-validator";

// The server re-checks the confirmation phrase, so a stray or scripted request
// can never wipe the users without it.
export class DeleteAllUsersDto {
    @Equals("DELETE ALL USERS", {
        message: 'confirm must be exactly "DELETE ALL USERS"',
    })
    confirm: string;
}
