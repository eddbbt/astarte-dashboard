describe('Groups page tests', () => {
  context('no access before login', () => {
    it('redirects to home', function () {
      cy.visit('/groups');
      cy.location('pathname').should('eq', '/login');
    });
  });

  context('authenticated', () => {
    beforeEach(() => {
      cy.fixture('realm').then((realm) => {
        cy.fixture('groups')
          .as('groups')
          .then((groups) => {
            groups.data.forEach((groupName) => {
              const encodedGroupName = encodeURIComponent(groupName);
              const groupFixture = groupName.startsWith('special characters')
                ? `group.special-characters.devices.json`
                : `group.${groupName}.devices.json`;
              cy.fixture(groupFixture).as(`${encodedGroupName}-devices`);
              // Browsers will convert single quotes but encodeURIComponent don't
              cy.intercept(
                'GET',
                `/appengine/v1/${realm.name}/groups/${encodeURIComponent(encodedGroupName).replace(
                  /'/g,
                  '%27',
                )}/devices?details=true`,
                { fixture: groupFixture },
              ).as(`${encodedGroupName}-request`);
            });
            cy.intercept('GET', `/appengine/v1/${realm.name}/groups`, groups);
            cy.login();
            cy.visit('/groups');
            const requestAliases = groups.data.map(
              (groupName) => `@${encodeURIComponent(groupName)}-request`,
            );
            cy.wait(requestAliases);
          });
      });
    });

    it('successfully loads Groups page', function () {
      cy.location('pathname').should('eq', '/groups');
      cy.get('h2').contains('Groups');
    });

    it('displays groups list correctly', function () {
      cy.get('.main-content').within(() => {
        cy.get('table tbody').find('tr').should('have.length', this.groups.data.length);
        this.groups.data.forEach((groupName, index) => {
          const encodedGroupName = encodeURIComponent(groupName);
          cy.get(`table tbody tr:nth-child(${index + 1})`).within(() => {
            const groupDevices = this[`${encodedGroupName}-devices`].data;
            const connectedGroupDevices = groupDevices.filter((d) => d.connected);
            cy.get('td:nth-child(1)').contains(groupName);
            cy.get('td:nth-child(2)').contains(connectedGroupDevices.length);
            cy.get('td:nth-child(3)').contains(groupDevices.length);
          });
        });
      });
    });

    it('has a button to create a new group', function () {
      cy.get('.main-content').within(() => {
        cy.get('button').contains('Create new group').click();
        cy.location('pathname').should('eq', '/groups/new');
      });
    });

    it("clicking on a group's name will correctly redirect to its page", () => {
      cy.get('.main-content').within(() => {
        // Find existing group's name, even with special characters
        const groupName = 'special characters %20///%%`~!@#$^&*()_-+=[]{};:\'"|\\<>,.';
        const encodedGroupName = encodeURIComponent(groupName);
        cy.get('table td').contains(groupName).click();
        cy.location('pathname').should(
          'eq',
          `/groups/${encodedGroupName}/edit`,
        );
      });
    });
  });
});
