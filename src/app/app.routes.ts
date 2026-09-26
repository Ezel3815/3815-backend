import { Routes } from "@angular/router";
import { CrudPageComponent } from "../components/crud-page/crud-page.component";
import { ConfigurableFocusTrap } from "@angular/cdk/a11y";
import { BaseCrudConfig } from "../cruds-configs/base-crud-config.model";
import { MembersCrudConfig } from "../cruds-configs/members.crud-config";
import { EducationalLevelsCrudConfig } from "../cruds-configs/educational-levels.crud-config";
import { TeachersCrudConfig } from "../cruds-configs/teachers.crud-config";
import { MarksCrudConfig } from "../cruds-configs/marks.crud-config";
import { SchoolClassesCrudConfig } from "../cruds-configs/school-classes.crud-config";
import { StudentsCheckInsService } from "../services/http-services/students-check-ins.service";
import { LoginComponent } from "../pages/login/login.component";
import { AuthGuard, LoggedInAuthGuard } from "./authGuard.service";
import { UsersCrudConfig } from "../cruds-configs/users.crud-config";
import { DecksCrudConfig } from "../cruds-configs/decks.crud-config";
import { CodesCrudConfig } from "../cruds-configs/codes.crud-config";
import { RestoreImagesComponent } from "../pages/restore-images/restore-images.component";
import { AiCardImportComponent } from "../pages/ai-card-import/ai-card-import.component";

export const routes: Routes = [
    {
        path: "restore-images",
        component: RestoreImagesComponent,
        canActivate: [AuthGuard],
    },
    {
        path: "ai-cards",
        component: AiCardImportComponent,
        canActivate: [AuthGuard],
    },
    {
        path: "auth/login",
        canActivate: [LoggedInAuthGuard],
        component: LoginComponent,
    },
    {
        path: "members",
        component: CrudPageComponent,
        canActivate: [AuthGuard],
        providers: [
            {
                provide: BaseCrudConfig,
                useClass: MembersCrudConfig,
            },
        ],
    },
    {
        path: "users",
        component: CrudPageComponent,
        canActivate: [AuthGuard],
        providers: [
            {
                provide: BaseCrudConfig,
                useClass: UsersCrudConfig,
            },
        ],
    },
    {
        path: "educational-levels",
        component: CrudPageComponent,
        canActivate: [AuthGuard],
        providers: [
            {
                provide: BaseCrudConfig,
                useClass: EducationalLevelsCrudConfig,
            },
        ],
    },
    {
        path: "teachers",
        component: CrudPageComponent,
        canActivate: [AuthGuard],
        providers: [
            {
                provide: BaseCrudConfig,
                useClass: TeachersCrudConfig,
            },
        ],
    },
    {
        path: "marks",
        component: CrudPageComponent,
        canActivate: [AuthGuard],
        providers: [
            {
                provide: BaseCrudConfig,
                useClass: MarksCrudConfig,
            },
        ],
    },
    {
        path: "decks",
        component: CrudPageComponent,
        canActivate: [AuthGuard],
        providers: [
            {
                provide: BaseCrudConfig,
                useClass: DecksCrudConfig,
            },
        ],
    },
    {
        path: "codes",
        component: CrudPageComponent,
        canActivate: [AuthGuard],
        providers: [
            {
                provide: BaseCrudConfig,
                useClass: CodesCrudConfig,
            },
        ],
    },
    {
        path: "school-classes",
        component: CrudPageComponent,
        canActivate: [AuthGuard],
        providers: [
            {
                provide: BaseCrudConfig,
                useClass: SchoolClassesCrudConfig,
            },
        ],
    },
];
