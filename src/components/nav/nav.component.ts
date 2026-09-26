import { Component, inject } from "@angular/core";
import { BreakpointObserver, Breakpoints } from "@angular/cdk/layout";
import { AsyncPipe, CommonModule } from "@angular/common";
import { MatToolbarModule } from "@angular/material/toolbar";
import { MatButtonModule } from "@angular/material/button";
import { MatSidenavModule } from "@angular/material/sidenav";
import { MatListModule } from "@angular/material/list";
import { MatIconModule } from "@angular/material/icon";
import { Observable } from "rxjs";
import { map, shareReplay } from "rxjs/operators";
import {
    ActivatedRoute,
    Router,
    RouterModule,
    UrlSegment,
} from "@angular/router";
import { TranslatePipe } from "../../pipes/translate.pipe";

@Component({
    selector: "app-nav",
    templateUrl: "./nav.component.html",
    styleUrl: "./nav.component.scss",
    standalone: true,
    imports: [
        MatToolbarModule,
        MatButtonModule,
        MatSidenavModule,
        MatListModule,
        MatIconModule,
        CommonModule,
        RouterModule,
        AsyncPipe,
        TranslatePipe,
    ],
})
export class NavComponent {
    title: string = "Flash Cards";
    constructor(private router: Router) {}
    private breakpointObserver = inject(BreakpointObserver);

    menuItems = [
        { path: "users", title: "Users" },
        { path: "decks", title: "Decks" },
        { path: "codes", title: "Codes" },
        { path: "restore-images", title: "Restore images" },
        { path: "ai-cards", title: "AI Card Import" },
    ];

    isHandset$: Observable<boolean> = this.breakpointObserver
        .observe(Breakpoints.Handset)
        .pipe(
            map((result) => result.matches),
            shareReplay(),
        );

    isAuth() {
        return this.router.url.includes("auth");
    }
    logOut() {
        localStorage.removeItem("auth_token");
        this.router.navigate(["/auth/login"]);
    }
}
